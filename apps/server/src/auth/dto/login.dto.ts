import { IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @Length(12, 256)
  password!: string;

  @IsOptional()
  @IsString()
  @Length(6, 32)
  totpCode?: string;
}

export class TotpCodeDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}
