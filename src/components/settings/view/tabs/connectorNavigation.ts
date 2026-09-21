/** Keeps browser navigation replaceable in unit tests without environment branches. */
export const navigateToConnectorAuthorization = (authorizeUrl: string): void => {
  window.location.assign(authorizeUrl);
};
