/**
 * @group-one/wap-client/server — type definitions.
 *
 * Node-only server SDK. The brand backend's single job: issue a GRND for the
 * logged-in user and hand it to the browser as {token} — the widget sends it
 * directly to WAP as the Bearer credential on every call. There is no
 * connection between the brand backend and WAP.
 *
 * Because the GRND is browser-held, issue SHORT-LIVED GRNDs (minutes to
 * hours, not the 32-day spec maximum).
 */

/** Machine-readable failure. Codes match the PHP WP_Error codes
 * (wap_grnd_malformed, wap_grnd_bad_alg, wap_grnd_bad_jti,
 * wap_grnd_missing_exp, wap_grnd_expired, wap_grnd_unavailable,
 * wap_grnd_not_entitled). Show end users a generic message for all of them. */
export declare class WapError extends Error {
    code: string;
    status?: number;
    constructor(code: string, message: string, status?: number);
}

/** Decoded GRND payload returned by the structural sanity check.
 * NOT cryptographic verification — signature checking is WAP's job. */
export declare function sanityCheckGrnd(grnd: string): { exp: number; jti: string; [k: string]: unknown };

/** Pluggable GRND cache. Use a Redis-backed implementation in
 * multi-instance deployments; MemoryStorage is per-process. */
export interface GrndStorage {
    get(key: string): string | null | undefined | Promise<string | null | undefined>;
    set(key: string, value: string, ttlSeconds: number): unknown | Promise<unknown>;
    delete(key: string): unknown | Promise<unknown>;
}

export declare class MemoryStorage implements GrndStorage {
    get(key: string): string | null;
    set(key: string, value: string, ttlSeconds: number): void;
    delete(key: string): void;
}

export interface GrndProviderContext {
    cacheKey: string;
    forceNew: boolean;
}

/** Brand-specific GRND source — the only per-brand code. Return the JWT
 * directly or {grnd, expires_at} (unix seconds cap from the issuer). */
export type GrndProvider = (
    ctx: GrndProviderContext
) => string | { grnd: string; expires_at?: number } | Promise<string | { grnd: string; expires_at?: number }>;

/**
 * GRND acquisition + per-user caching. This IS the session endpoint's
 * implementation: wire get() to the route behind YOUR authentication and
 * return {token: grnd} to the browser widget. Pass the widget's forceNew
 * flag through so a WAP 401 (expired/revoked GRND) heals in one round trip.
 *
 * GRNDs are product-scoped: use one TokenManager per product (distinct
 * keyPrefix), or include the product in every cacheKey — otherwise a
 * multi-product host would serve one product's GRND for another.
 */
export declare class TokenManager {
    constructor(opts: { provider: GrndProvider; storage?: GrndStorage; keyPrefix?: string });
    /** Sane GRND from cache or freshly acquired. TTL = min(exp, expires_at) − 60s. */
    get(opts?: { cacheKey?: string; forceNew?: boolean }): Promise<string>;
    /** Drop the cached GRND (logout, credential rotation, entitlement change). */
    forget(cacheKey?: string): Promise<void>;
}

/** Provider for brands exposing the standardized issuer endpoint (same
 * contract as the PHP LicenseGrndProvider). The optional credentials factory
 * runs lazily on cache miss only — e.g. to seal a credential for the
 * wrapped_app_token/wrap_key_id fields. */
export declare function createIssuerProvider(opts: {
    issuerUrl: string;
    product: string;
    siteUrl: string;
    licenseKey?: string;
    credentials?: (ctx: GrndProviderContext) => Record<string, unknown> | Promise<Record<string, unknown>>;
    fetchImpl?: typeof fetch;
}): GrndProvider;

/**
 * The facade — one object, one method. Wires TokenManager (with a per-product
 * cache namespace) and, when no custom provider is given, the standardized
 * issuer exchange. `getGrnd()` returns the exact value your session endpoint
 * hands to the widget as {token}.
 */
export declare class WapGrndClient {
    constructor(opts: {
        /** Product slug registered with WAP; also namespaces the GRND cache. */
        product: string;
        /** Your GRND source. Omit to use the standardized issuer exchange
         * (then issuerUrl + siteUrl are required). */
        provider?: GrndProvider;
        issuerUrl?: string;
        siteUrl?: string;
        licenseKey?: string;
        credentials?: (ctx: GrndProviderContext) => Record<string, unknown> | Promise<Record<string, unknown>>;
        /** Redis-backed storage in multi-instance deploys. */
        storage?: GrndStorage;
        fetchImpl?: typeof fetch;
    });
    /** Validated, cached GRND for this user. Pass the widget's forceNew flag through. */
    getGrnd(opts?: { userKey?: string; forceNew?: boolean }): Promise<string>;
    /** Drop a user's cached GRND (logout, entitlement change). */
    forget(userKey?: string): Promise<void>;
}
