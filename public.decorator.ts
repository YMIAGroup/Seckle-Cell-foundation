import { SetMetadata } from '@nestjs/common';
/** Marks a route as exempt from the global JwtAuthGuard (e.g. POST /auth/login). */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
