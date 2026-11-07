import path from 'node:path';
import { env } from '../config/env';
import { MediaStore } from './media-store';

let store: MediaStore | null = null;
let logger: ((message: string, data?: Record<string, unknown>) => void) | undefined;

export const configureMediaLogger = (log: (message: string, data?: Record<string, unknown>) => void) => {
    logger = log;
};

/** Process-wide virtual SD card shared by every virtual camera. */
export const getMediaStore = (): MediaStore => {
    store ??= new MediaStore(
        path.resolve(env.SIMULATOR_MEDIA_ROOT),
        env.SIMULATOR_MEDIA_QUOTA_BYTES,
        (message, data) => logger?.(message, data),
    );
    return store;
};
