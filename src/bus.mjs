/**
 * 进程内事件总线：把 log() 的每一行广播出去，供 Web 控制台做实时日志流。
 * 不依赖任何第三方库。
 */
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(64);
