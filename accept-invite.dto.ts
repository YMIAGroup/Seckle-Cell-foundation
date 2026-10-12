import { IsString, MinLength } from 'class-validator';
import { IsStrongPassword } from '../password-policy';

export class AcceptInviteDto {
  @IsString() @MinLength(1) token!: string;
  @IsString() @IsStrongPassword() newPassword!: string;
}
