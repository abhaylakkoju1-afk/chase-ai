/* =========================================================
   ACCOUNT FEATURE FLAGS — both OFF.
   Changing either is a reviewed PR of its own (D15):
   - PRODUCTION_SUPABASE_ACCOUNTS: Supabase accounts on swimtics.com.
     Also needs a production config and PRODUCTION_PROJECT_REF
     (supabase-env.js); without them production mode stays off anyway.
   - PRODUCTION_PUBLIC_SIGNUPS: shows Sign Up in production. Must stay
     false until the under-18 consent approach has qualified Indian legal
     advice and the privacy policy is reviewed and published. Sign-ups are
     also disabled in the swimtics-production dashboard.
   ========================================================= */

export const PRODUCTION_SUPABASE_ACCOUNTS = false;
export const PRODUCTION_PUBLIC_SIGNUPS = false;

/* The only hosts production accounts ever run on (also used by
   supabase-env.js), here so production-accounts.js can check the host
   before it loads anything else. */
export const PRODUCTION_HOSTS = Object.freeze(["swimtics.com", "www.swimtics.com"]);
