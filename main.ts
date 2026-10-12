// Must run before anything else reads process.env -- including
// loadAndValidateEnv() below, which is why this isn't wired up via
// @nestjs/config's ConfigModule instead: that only takes effect once
// Nest starts building the module graph, which is a step too late for
// the synchronous env check that happens before NestFactory.create().
// package.json lists @nestjs/config as a dependency but nothing in this
// codebase actually calls it -- this was effectively a no-op before.
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import type { Request, Response, NextFunction } from 'express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { loadAndValidateEnv } from './config/env.validation';

async function bootstrap() {
  const env = loadAndValidateEnv();
  const app = await NestFactory.create(AppModule);

  // Standard security headers (HSTS, X-Content-Type-Options, X-Frame-Options,
  // a conservative CSP, etc.) applied to every response with one call.
  //
  // Helmet's default CSP blocks inline <script> tags and loads nothing
  // off-origin, which is exactly what should be blocked on real application
  // pages -- both the /portal frontend and the public website below are
  // written entirely as external .js files for this reason, never inline,
  // so script-src stays strict ('self' only) everywhere. Two narrow
  // exceptions are needed, not loosened away:
  //   - style-src allows 'unsafe-inline' because the public website's hand
  //     written pages use plain style="..." attributes in a few places
  //     (e.g. inline colour accents) rather than a class per one-off value;
  //     this does not affect script execution at all.
  //   - style-src/font-src allow fonts.googleapis.com/fonts.gstatic.com
  //     because the website's stylesheet loads Source Serif 4 and Inter
  //     from Google Fonts via @import.
  // Swagger UI's own bundled page additionally needs inline *scripts* to
  // boot itself, which neither the website nor /portal need, so that one
  // extra allowance stays scoped to the /api/docs path only, below.
  const strictHelmet = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: [`'self'`],
        scriptSrc: [`'self'`],
        styleSrc: [`'self'`, `'unsafe-inline'`, 'https://fonts.googleapis.com'],
        fontSrc: [`'self'`, 'https://fonts.gstatic.com'],
        imgSrc: [`'self'`, 'data:'],
      },
    },
  });
  const relaxedHelmetForDocs = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: [`'self'`],
        styleSrc: [`'self'`, `'unsafe-inline'`],
        scriptSrc: [`'self'`, `'unsafe-inline'`],
        imgSrc: [`'self'`, 'data:'],
      },
    },
  });
  app.use((req: Request, res: Response, next: NextFunction) => (req.path.startsWith('/api/docs') ? relaxedHelmetForDocs : strictHelmet)(req, res, next));

  // Without this, none of the DTO class-validator decorators run —
  // requests would reach services with unvalidated shapes.
  // whitelist strips any property not declared on the DTO;
  // forbidNonWhitelisted rejects the request outright if extras are sent,
  // so a client can't smuggle e.g. { donorUserId: "someone-else" } through.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  // Only the configured frontend origin(s) may call this API with credentials.
  // A bare app.enableCors() (the old setting) accepts every origin, which is
  // fine for a demo but not for anything handling real donor or child data.
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });

  // OpenAPI/Swagger: machine-readable metadata for every route (so any client,
  // or Postman, or a future frontend, can discover the API without reading the
  // source), served at /api/docs. Harmless to leave on in production -- it
  // describes shapes, not secrets -- but can be disabled below if preferred.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('SCCF Platform API')
    .setDescription('Sickle Cell Child Care Foundation -- care coordination, donor, and finance API.')
    .setVersion('0.2.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(env.PORT);
  console.log(`SCCF API listening on :${env.PORT} [${env.NODE_ENV}]`);
  console.log(`API docs: http://localhost:${env.PORT}/api/docs`);
}
bootstrap();
