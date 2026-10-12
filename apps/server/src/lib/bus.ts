import { EventEmitter } from 'node:events';
import type { ChangeTopic, MetricsSample } from '@apexos/api-types';

interface BusEvents {
  changed: [ChangeTopic];
  metrics: [MetricsSample];
}

/** Process-wide event bus for things the UI should hear about over SSE. */
export class Bus extends EventEmitter<BusEvents> {
  changed(topic: ChangeTopic): void {
    this.emit('changed', topic);
  }
}
