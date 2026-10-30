/** A Google Play package name (e.g. com.andyshephard.chunks). */
export const PACKAGE_ID = /^[A-Za-z][\w]*(\.[\w]+)+$/;

/** Longest package name accepted where one is stored (Play's own limit is lower). */
export const MAX_PACKAGE_ID_LENGTH = 200;

/** True for a package name that may be tracked; shared by the API and the dashboard. */
export function isPlayPackageId(value: string): boolean {
  return value.length <= MAX_PACKAGE_ID_LENGTH && PACKAGE_ID.test(value);
}
