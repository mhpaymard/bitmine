import type { AdminRole } from '@prisma/client';

export interface AuthenticatedAdmin {
  id: string;
  email: string;
  displayName: string;
  role: AdminRole;
  sessionId: string;
  csrfToken: string;
}

export interface SessionPayload extends AuthenticatedAdmin {
  createdAt: string;
  lastSeenAt: string;
}
