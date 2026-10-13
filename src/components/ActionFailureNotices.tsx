// The notices of failed actions of this tab (src/lib/actionFailures.ts): one
// per kind of action, each closed by its own cross. The shape is the one of
// every failure notice (DESIGN_SYSTEM.md, «Сбой после закрытия окна»): the
// title, what the failure left in the quiet tone, the error in the
// destructive tone.

import { dismissActionFailure, useActionFailures, type ActionFailure } from "@/lib/actionFailures";
import { NotificationCard } from "./NotificationCard";

export function ActionFailureNotices({ failures }: { failures: readonly ActionFailure[] }) {
  return (
    <>
      {failures.map((failure) => (
        <NotificationCard
          key={failure.kind}
          title={failure.title}
          onClose={() => dismissActionFailure(failure.kind)}
        >
          {failure.summary && (
            <p className="text-sm text-muted-foreground" data-action-failure-summary={failure.kind}>
              {failure.summary}
            </p>
          )}
          {failure.messages.map((message, index) => (
            <p
              // Lines of one notice are fixed once reported.
              key={index}
              className="text-sm text-destructive"
              data-action-failure-notice={failure.kind}
            >
              {message}
            </p>
          ))}
        </NotificationCard>
      ))}
    </>
  );
}

/** The notices of this tab's store, for a surface without App's stack: the
 *  tests of a component that reports a failure. */
export function ActionFailureNoticeStack() {
  return <ActionFailureNotices failures={useActionFailures()} />;
}
