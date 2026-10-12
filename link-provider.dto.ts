import { IsUUID } from 'class-validator';
export class LinkProviderDto {
  @IsUUID() providerId!: string;
}
