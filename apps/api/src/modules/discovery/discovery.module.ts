import { Module } from '@nestjs/common';
import { resolve4, resolve6 } from 'node:dns/promises';
import { DNS_RESOLVER } from '../../tokens.js';
import { DiscoveryController } from './discovery.controller.js';
import { DiscoveryService, type DnsResolver } from './discovery.service.js';

const systemResolver: DnsResolver = async (hostname) => {
  const [v4, v6] = await Promise.all([
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => []),
  ]);
  return [...v4, ...v6];
};

@Module({
  controllers: [DiscoveryController],
  providers: [{ provide: DNS_RESOLVER, useValue: systemResolver }, DiscoveryService],
  exports: [DiscoveryService, DNS_RESOLVER],
})
export class DiscoveryModule {}
