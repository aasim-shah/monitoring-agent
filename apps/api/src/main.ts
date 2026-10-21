import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(config), new FastifyAdapter());
app.enableShutdownHooks();
await app.listen({ port: config.port, host: '0.0.0.0' });
