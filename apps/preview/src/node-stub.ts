// Stands in for pg and node:crypto in the browser build. Only the API's server paths use them (the connection pool,
// document storage), and the preview runs neither: it has its own in-browser database and no document storage.
const absent = () => { throw new Error('not available in the browser preview'); };
export default { Pool: absent, Client: absent };
export const createHash = absent;
export const timingSafeEqual = absent;
export const randomUUID = () => crypto.randomUUID();
