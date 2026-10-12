import { IsString, MinLength } from 'class-validator';
export class MfaDisableDto {
  @IsString() @MinLength(1) password!: string;
}
