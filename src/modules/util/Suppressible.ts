// A setting the user owns that something else can temporarily take over.
//
// CONTEXT.md already names the idea — suppression, as distinct from inert — and
// the app had three separate implementations of it: the terrain a surface model
// insists on, the camera mode the sky view cannot share, and the components a
// scene morph has to hide. Same three verbs and the same two fields each time,
// no shared code, and the comment on one of them pointed at another by name.
//
// They had drifted the way separately-written copies do. Only one could be read
// back, so the menu reconstructed the terrain in force from the same inputs the
// controller used instead of asking. Only one reported whether it had changed
// anything. Each grew its own staleness guard for out-of-order async applies.
//
// Cesium-free on purpose: what is being suppressed is a value, and enacting it is
// the caller's business.

/**
 * Enact the resolved value.
 *
 * `isCurrent` answers "is this still the newest apply?" — for an apply that has
 * to await something, checking it after each await is what stops a slow one that
 * resolves late from overwriting a newer one. Sync applies can ignore it.
 */
export type Apply<T> = (value: T, isCurrent: () => boolean) => void | Promise<void>;

/**
 * A chosen value, an optional override, and whatever wins.
 *
 * Nothing here writes the user's choice: suppressing leaves `chosen` exactly as
 * it was, which is what lets the toolbar go on saying so and the url survive the
 * round trip.
 */
export class Suppressible<T> {
  #chosen: T;

  #override: T | undefined;

  #apply: Apply<T>;

  #generation = 0;

  /** No apply on construction: the initial value is what the world already shows. */
  constructor(initial: T, apply: Apply<T>) {
    this.#chosen = initial;
    this.#apply = apply;
  }

  /** What the user picked, whether or not it is being honoured. */
  get chosen(): T {
    return this.#chosen;
  }

  /** What is actually enacted right now. */
  get inForce(): T {
    return this.#override ?? this.#chosen;
  }

  get suppressed(): boolean {
    return this.#override !== undefined;
  }

  /**
   * Record the user's choice. Applied only if it is the one in force — a choice
   * made under a suppression is what comes back on release, and enacting it now
   * would do work for something nobody is going to see.
   *
   * @returns whether this changed what is in force.
   */
  choose(value: T): boolean {
    if (Object.is(value, this.#chosen)) {
      return false;
    }
    const before = this.inForce;
    this.#chosen = value;
    return this.#reapply(before);
  }

  /**
   * Take the setting over, without touching the choice underneath.
   *
   * @returns whether this changed what is in force.
   */
  suppress(value: T): boolean {
    if (Object.is(value, this.#override)) {
      return false;
    }
    const before = this.inForce;
    this.#override = value;
    return this.#reapply(before);
  }

  /**
   * Hand the setting back.
   *
   * @returns whether this changed what is in force.
   */
  release(): boolean {
    if (this.#override === undefined) {
      return false;
    }
    const before = this.inForce;
    this.#override = undefined;
    return this.#reapply(before);
  }

  #reapply(before: T): boolean {
    const value = this.inForce;
    if (Object.is(value, before)) {
      return false;
    }
    const generation = ++this.#generation;
    void this.#apply(value, () => generation === this.#generation);
    return true;
  }
}

/** What changed, for a caller that enacts a set one name at a time. */
export interface SetChange {
  show: string[];
  hide: string[];
}

/**
 * The same idea for a set, where each member is suppressed independently.
 *
 * Separate from `Suppressible<T>` rather than forced into it: an override that
 * replaces a value and a set difference are not the same operation, and pretending
 * otherwise would cost more than the two share. What they do share is the rule —
 * the chosen set is never edited by a suppression — and the vocabulary.
 *
 * It remembers what it last put in force, so the caller does not have to
 * reconstruct the previous effective set to work out the difference.
 */
export class SuppressibleSet {
  #chosen: readonly string[] = [];

  #suppressed = new Set<string>();

  #inForce = new Set<string>();

  #apply: (change: SetChange) => void;

  constructor(apply: (change: SetChange) => void) {
    this.#apply = apply;
  }

  get chosen(): readonly string[] {
    return this.#chosen;
  }

  get inForce(): string[] {
    return [...this.#inForce];
  }

  isSuppressed(name: string): boolean {
    return this.#suppressed.has(name);
  }

  /** Record the user's choice, and enact the difference. */
  choose(values: readonly string[]): void {
    this.#chosen = [...values];
    this.#settle();
  }

  /**
   * Hide one member for as long as something else needs it out of the way.
   *
   * @returns whether this actually hid anything — false when it was already
   * suppressed, or when the user does not have it switched on in the first place.
   */
  suppress(name: string): boolean {
    if (this.#suppressed.has(name) || !this.#chosen.includes(name)) {
      return false;
    }
    this.#suppressed.add(name);
    this.#settle();
    return true;
  }

  /** @returns whether this brought anything back. */
  release(name: string): boolean {
    if (!this.#suppressed.delete(name)) {
      return false;
    }
    return this.#settle().show.length > 0;
  }

  #settle(): SetChange {
    const next = new Set(this.#chosen.filter((name) => !this.#suppressed.has(name)));
    const show = [...next].filter((name) => !this.#inForce.has(name));
    const hide = [...this.#inForce].filter((name) => !next.has(name));
    this.#inForce = next;
    if (show.length > 0 || hide.length > 0) {
      this.#apply({ show, hide });
    }
    return { show, hide };
  }
}
