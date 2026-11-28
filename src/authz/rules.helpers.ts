/** A caller with a session or token: the floor of every rule that is not `public`. */
export const signedIn = { authenticated: true } as const;

/** No caller needed: the field or route proves what it needs itself (a credential, a throttle). */
export const open = { public: true } as const;
