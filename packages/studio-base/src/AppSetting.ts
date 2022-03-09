// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

export enum AppSetting {
  // General
  COLOR_SCHEME = "colorScheme",
  TIMEZONE = "timezone",
  TIME_FORMAT = "time.format",
  MESSAGE_RATE = "messageRate",
  UPDATES_ENABLED = "updates.enabled",

  // ROS
  ROS_PACKAGE_PATH = "ros.ros_package_path",

  // Privacy
  TELEMETRY_ENABLED = "telemetry.telemetryEnabled",
  CRASH_REPORTING_ENABLED = "telemetry.crashReportingEnabled",

  // Experimental features
  UNLIMITED_MEMORY_CACHE = "experimental.unlimited-memory-cache",
  SHOW_DEBUG_PANELS = "showDebugPanels",
  ENABLE_LEGACY_PLOT_PANEL = "enableLegacyPlotPanel",
  EXPERIMENTAL_BAG_PLAYER = "experimental.bag-player",

  // Miscellaneous
  HIDE_SIGN_IN_PROMPT = "hideSignInPrompt",
  LAUNCH_PREFERENCE = "launchPreference",
  OPEN_DIALOG = "ui.open-dialog",
  SHOW_OPEN_DIALOG_ON_STARTUP = "ui.open-dialog-startup",

  // Dev only
  ENABLE_LAYOUT_DEBUGGING = "enableLayoutDebugging",
  ENABLE_REACT_STRICT_MODE = "enableReactStrictMode",
}
