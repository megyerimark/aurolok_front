/**
 * Minimal typed publish/subscribe bus. The simulation layer emits facts
 * ("door opened", "npc refused"); presentation layers (audio, UI, rendering)
 * subscribe. Nothing in the simulation depends on who is listening.
 */
export type Handler<T> = (payload: T) => void;

export class EventBus<Events extends { [K in keyof Events]: unknown }> {
  private handlers = new Map<keyof Events, Set<Handler<any>>>();

  on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const h of [...set]) h(payload);
  }
}
