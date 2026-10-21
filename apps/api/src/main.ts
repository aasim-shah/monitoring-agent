import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
// The API is reachable only through Caddy on the internal edge network, so
// X-Forwarded-For from the proxy is trusted for client IPs (rate limits).
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule.register(config),
  new FastifyAdapter({ trustProxy: true }),
);
await app.register(fastifyCookie);
app.enableShutdownHooks();
await app.listen({ port: config.port, host: '0.0.0.0' });
