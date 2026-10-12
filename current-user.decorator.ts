import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Usage: create(@CurrentUser() user: { id: string }) — reads request.user set by JwtAuthGuard. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().user;
});
