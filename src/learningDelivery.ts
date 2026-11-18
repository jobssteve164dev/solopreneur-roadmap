import { createHmac, timingSafeEqual } from 'crypto';

export interface LearningDelivery {
  sessionToken: string;
  actorId: string;
  projectId: string;
  runId: string;
  turnId: string;
  lessons: Array<{ objectId: string; revision: number }>;
  piToolFence?: { operationId: string; invocationId: string; ownerId: string; ownerGeneration: number };
}

export function signLearningDelivery(value: LearningDelivery, secret: string): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(`learning-delivery-v1:${body}`).digest('base64url')}`;
}

export function verifyLearningDelivery(value: string, secret: string): LearningDelivery {
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra) throw new Error('learning_delivery_invalid');
  const expected = createHmac('sha256', secret).update(`learning-delivery-v1:${body}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new Error('learning_delivery_invalid');
  const result = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LearningDelivery;
  if (!Array.isArray(result.lessons) || !result.lessons.length) throw new Error('learning_delivery_invalid');
  return result;
}
