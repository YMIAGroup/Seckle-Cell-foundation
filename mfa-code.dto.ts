import { IsString, Length } from 'class-validator';
export class MfaCodeDto {
  @IsString() @Length(6, 6) code!: string;
}
