export class ProjectionStore {
  constructor(storage: DurableObjectStorage);
  hasEvent(eventId: string): boolean;
  read(): Promise<any>;
  activate(eventId: string, posts: any[]): Promise<any>;
}
export function createProjectionObject(options: {
  validateEvent: (event: any, env: any) => void;
  fetchPosts: (env: any, fetcher: typeof fetch) => Promise<any[]>;
  validateSnapshot: (event: any, posts: any[]) => string;
}): {
  new(state: DurableObjectState, env: any): {
    store: ProjectionStore;
    handle(event: any, fetcher?: typeof fetch): Promise<any>;
    fetch(request: Request): Promise<Response>;
  };
};
export function projectionStub(binding: DurableObjectNamespace, siteKey: string): DurableObjectStub;
