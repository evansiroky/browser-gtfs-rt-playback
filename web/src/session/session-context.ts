import { createContext } from 'react';
import type { ActivityController } from './activity-controller';

export const SessionContext = createContext<ActivityController | null>(null);
