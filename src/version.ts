/** This package's version; a test keeps it equal to package.json's. */
export const PLUGIN_VERSION = '0.1.0';

/**
 * Sent as X-CodePush-Plugin-Name. It is the value Cordova-based clients already send to Revopush; whether the
 * server keys anything on it is not known, so it is kept rather than changed.
 */
export const PLUGIN_NAME_HEADER = 'native-code-push';

/** Sent as X-CodePush-SDK-Version: the microsoft/code-push release whose acquisition protocol this client speaks. */
export const PROTOCOL_SDK_VERSION = '4.2.3';
