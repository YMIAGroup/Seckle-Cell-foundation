import { IsEmail, IsString, IsOptional, MinLength, MaxLength, Matches } from 'class-validator';
import { IsStrongPassword } from '../password-policy';

export class SignupDto {
  @IsEmail() email!: string;
  @IsString() @IsStrongPassword() password!: string;
  @IsString() @MinLength(1) @MaxLength(100) firstName!: string;
  @IsString() @MinLength(1) @MaxLength(100) lastName!: string;
  @IsOptional() @IsString() @Matches(/^\+?[0-9 ()-]{7,20}$/, { message: 'Phone number looks invalid.' }) phone?: string;
}
