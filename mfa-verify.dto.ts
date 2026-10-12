import { IsString, MinLength, Length } from 'class-validator';
export class MfaVerifyDto {
  @IsString() @MinLength(1) mfaToken!: string;
  @IsString() @Length(6, 6) code!: string;
}
