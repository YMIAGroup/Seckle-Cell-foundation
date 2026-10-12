import { IsEmail, IsString, IsOptional, MinLength, MaxLength, Matches } from 'class-validator';
import { IsStrongPassword } from '../password-policy';

export class SignupProviderDto {
  @IsEmail() email!: string;
  @IsString() @IsStrongPassword() password!: string;
  @IsString() @MinLength(1) @MaxLength(100) firstName!: string;
  @IsString() @MinLength(1) @MaxLength(100) lastName!: string;
  @IsString() @MinLength(2) @MaxLength(255) organizationName!: string;
  @IsOptional() @IsString() @Matches(/^\+?[0-9 ()-]{7,20}$/, { message: 'Phone number looks invalid.' }) phone?: string;
}
