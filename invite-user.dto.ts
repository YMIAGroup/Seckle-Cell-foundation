import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';
export class InviteUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(1) @MaxLength(100) firstName!: string;
  @IsString() @MinLength(1) @MaxLength(100) lastName!: string;
  @IsString() @MinLength(1) roleCode!: string;
}
