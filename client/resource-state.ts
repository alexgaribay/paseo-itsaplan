export type ResourceState<T> = { data?: T; error?: string; loading: boolean };
export type ResourceEvent<T> = { type: "start"; preserve: boolean } | { type: "loaded"; data: T } | { type: "failed"; error: string };

export function resourceState<T>(state: ResourceState<T>, event: ResourceEvent<T>): ResourceState<T> {
  switch (event.type) {
    case "start": return event.preserve ? { ...state, loading: true } : { loading: true };
    case "loaded": return { data: event.data, loading: false };
    case "failed": return { ...state, error: event.error, loading: false };
  }
}
