// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Theme, Typography, Link, Stack, Divider } from "@mui/material";
import { makeStyles } from "@mui/styles";
import { ErrorInfo, useMemo, useState } from "react";

const useStyles = makeStyles((theme: Theme) => ({
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    padding: theme.spacing(2),
    overflow: "auto",
  },
  alertContainer: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
  },
  errorDetailHeader: {
    fontWeight: "bold",
  },
  errorDetailStack: {
    fontSize: theme.typography.body2.fontSize,
    lineHeight: "1.3em",
    paddingLeft: theme.spacing(2),
  },
  errorDetailContainer: {
    overflowY: "auto",
    background: theme.palette.background.paper,
    padding: theme.spacing(1),
  },
  actions: {
    paddingTop: theme.spacing(2),
    textAlign: "right",
  },
}));

/**
 * Remove source locations (which often include file hashes) so storybook screenshots can be
 * deterministic.
 */
function sanitizeStack(stack: string) {
  return stack.replace(/\s+\(.+\)$/gm, "").replace(/\s+https?:\/\/.+$/gm, "");
}

function ErrorStacktrace({
  stack,
  hideSourceLocations,
}: {
  stack: string;
  hideSourceLocations: boolean;
}) {
  const styles = useStyles();
  const lines = (hideSourceLocations ? sanitizeStack(stack) : stack)
    .trim()
    .replace(/^\s*at /gm, "")
    .split("\n")
    .map((line) => line.trim());
  return (
    <pre className={styles.errorDetailStack}>
      {lines.map((line, i) => {
        const match = /^(.+)\s(\(.+$)/.exec(line);
        if (!match) {
          return line + "\n";
        }
        return (
          <span key={i}>
            <span>{match[1]} </span>
            <span>{match[2]}</span>
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

type ErrorDisplayProps = {
  title?: string;
  error?: Error;
  errorInfo?: ErrorInfo;
  content?: JSX.Element;
  actions?: JSX.Element;
  showErrorDetails?: boolean;
  hideErrorSourceLocations?: boolean;
};

function ErrorDisplay(props: ErrorDisplayProps): JSX.Element {
  const styles = useStyles();
  const { error, errorInfo, hideErrorSourceLocations = false } = props;

  const [showErrorDetails, setShowErrorDetails] = useState(props.showErrorDetails ?? false);

  const errorDetails = useMemo(() => {
    if (!showErrorDetails) {
      return ReactNull;
    }

    let stackWithoutMessage = error?.stack ?? "";
    const errorString = error?.toString() ?? "";
    if (stackWithoutMessage.startsWith(errorString)) {
      stackWithoutMessage = stackWithoutMessage.substring(errorString.length);
    }

    return (
      <div>
        <Typography className={styles.errorDetailHeader}>Error stack:</Typography>
        <ErrorStacktrace
          stack={stackWithoutMessage}
          hideSourceLocations={hideErrorSourceLocations}
        />
        {errorInfo && (
          <>
            <Typography className={styles.errorDetailHeader}>Component stack:</Typography>
            <ErrorStacktrace
              stack={errorInfo.componentStack}
              hideSourceLocations={hideErrorSourceLocations}
            />
          </>
        )}
      </div>
    );
  }, [error, errorInfo, hideErrorSourceLocations, showErrorDetails, styles.errorDetailHeader]);

  return (
    <div className={styles.root}>
      <div className={styles.alertContainer}>
        <Typography variant="h4">
          {props.title ?? "The app encountered an unexpected error"}
        </Typography>
        <Stack spacing={2}>
          <Typography variant="body1" component="div">
            {props.content}
          </Typography>
          <Divider />
          <Typography variant="subtitle2" component="code" fontWeight="bold">
            {error?.message}
          </Typography>
          <Link color="secondary" onClick={() => setShowErrorDetails(!showErrorDetails)}>
            {showErrorDetails ? "Hide" : "Show"} details
          </Link>
          {errorDetails && <div className={styles.errorDetailContainer}>{errorDetails}</div>}
        </Stack>
      </div>
      <div className={styles.actions}>{props.actions}</div>
    </div>
  );
}

export default ErrorDisplay;
