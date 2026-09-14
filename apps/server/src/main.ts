import 'reflect-metadata';
import { existsSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Environment } from './config/environment';
import { readSecretFile } from './config/environment';
import { BigIntInterceptor } from './common/bigint.interceptor';
import { HttpExceptionFilter } from './common/http-exception.filter';

async function bootstrap(): Promise<void> {
  for (const environmentFile of [
    resolve(process.cwd(), '../../.env'),
    resolve(process.cwd(), '.env'),
  ]) {
    if (existsSync(environmentFile)) loadEnvFile(environmentFile);
  }
  const { AppModule } = await import('./app.module');
  const trustedProxies = (process.env.TRUST_PROXY ?? '127.0.0.1,::1,172.16.0.0/12')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: trustedProxies, bodyLimit: 1_048_576, logger: false }),
    { bufferLogs: true },
  );
  const config = app.get(ConfigService<Environment, true>);
  await app.register(cookie, {
    secret: readSecretFile(config.get('COOKIE_SECRET_FILE', { infer: true })),
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
  });
  await app.register(compress);
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });
  app.enableCors({
    origin: config
      .get('ADMIN_ORIGIN', { infer: true })
      .split(',')
      .map((value) => value.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalInterceptors(new BigIntInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();

  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Mining Gateway API')
        .setDescription('Admin-only Bitcoin and Monero mining gateway API')
        .setVersion('1.0')
        .addCookieAuth('mitm_session')
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
  }

  const staticRoot = resolve(process.cwd(), '../admin/dist');
  if (config.get('SERVE_ADMIN_STATIC', { infer: true }) && existsSync(staticRoot)) {
    const fastify = app.getHttpAdapter().getInstance();
    const adminFallback = (request: FastifyRequest, reply: FastifyReply) => {
      if (
        request.url.startsWith('/api/') ||
        request.url.startsWith('/health') ||
        request.url === '/metrics'
      ) {
        return reply.code(404).send({ error: { status: 404, message: 'Not found' } });
      }
      const assetMatch = request.url.split('?', 1)[0]?.match(/^\/assets\/([a-zA-Z0-9_.-]+)$/u);
      if (assetMatch?.[1]) {
        const extension = assetMatch[1].split('.').at(-1)?.toLowerCase();
        const contentTypes: Record<string, string> = {
          css: 'text/css; charset=utf-8',
          js: 'text/javascript; charset=utf-8',
          json: 'application/json; charset=utf-8',
          map: 'application/json; charset=utf-8',
          png: 'image/png',
          svg: 'image/svg+xml',
          webp: 'image/webp',
          woff2: 'font/woff2',
        };
        const assetPath = resolve(staticRoot, 'assets', assetMatch[1]);
        if (extension && contentTypes[extension] && existsSync(assetPath)) {
          return reply
            .header('cache-control', 'public, max-age=31536000, immutable')
            .type(contentTypes[extension])
            .send(createReadStream(assetPath));
        }
        return reply.code(404).send({ error: { status: 404, message: 'Asset not found' } });
      }
      return reply.type('text/html').send(createReadStream(resolve(staticRoot, 'index.html')));
    };
    fastify.get('/', adminFallback);
    fastify.get('/*', adminFallback);
  }

  await app.listen({
    host: config.get('HTTP_HOST', { infer: true }),
    port: config.get('HTTP_PORT', { infer: true }),
  });
}

void bootstrap();
