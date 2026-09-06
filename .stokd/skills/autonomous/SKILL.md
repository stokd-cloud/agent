---
name: autonomous
description: >
  Finish the whole request without stopping and without pausing for preference
  questions. Use when the user says autonomous, autonomously, "do this
  autonomously", "handle it autonomously", "run it autonomously", "work
  autonomously", or /autonomous. Stay on for that request until every declared
  item is done. Turn off on "stop autonomous".
invocation: auto
---

# Autonomous

The user asked for the work, not a design review and not a status report. Do not stop twenty seconds in to ask whether the icon should be cornflower blue — and do not stop twenty minutes in to tell them how it is going.

There are two ways to fail this request. Asking a question you could have answered yourself, and **handing back an unfinished work-list**. The second one is the common one.

## Mode

On for the current request and any continuation of that same work until every declared item is done.

Stay on for the rest of the session if they say "stay autonomous" or "from now on".
Turn off only when they say "stop autonomous" or "ask me again".

This skill does not bypass Stokd governance, production/account safety, or irreversible data-loss stops. Those already fail the undo test below.

## First action: register the work-list

Before doing any of the work, decompose the request into its items and register them:

```
stokd autonomous start --request "<one line: what the user asked for>" --items "
item 1
item 2
item 3
"
```

This is not bookkeeping. It is the mechanism that holds you to the request: while any item is unchecked, your turn cannot end. If you skip this step you will drift off after the first item like every agent before you did.

Register the **whole** request, including the finishing work — validation, and landing if the user expects it shipped. An item you did not declare is an item you will not do.

Discharge each item **only when it is genuinely finished** — its code is written *and* its validation passed:

```
stokd autonomous done <ordinal|text>
```

If an item turns out to be genuinely impossible, say so explicitly rather than quietly dropping it:

```
stokd autonomous done <ordinal> --skip --reason "<why>"
```

Check `stokd autonomous status` any time you are unsure what is left.

## Do not end the turn

A turn ends when you send a message without a tool call. That means **you can end this request by accident**, just by talking. This is the single most common way autonomous work dies, so treat it as a hard rule:

- **Never send a narration-only message.** "Continuing autonomously — next up is item 3" ends the turn. So does "Both agents are running in parallel", "Now I'll integrate these", and every other progress update. If you have something to say about remaining work, it ships **with** the tool call that advances that work, or it does not ship.
- **A finished subagent is a continuation signal, not a checkpoint.** When a delegated agent reports back, the next thing you emit is the tool call for the next item — not a summary of what just happened.
- **A completed item is not a stopping point.** Discharge it and start the next one in the same turn.
- **Do not ask for confirmation to continue.** You already have it.

Save the reporting for closeout, when the work-list is empty.

## decide-and-continue

When a fork appears:

1. Pick the option that best serves the stated request.
2. Continue. Do not end the turn.
3. If the choice is notable, add one line to the decision log.

A decision is **notable** when a user reviewing the finished work would reasonably want to know it was chosen: architecture, library, public API/data shape, omitted scope, or a real tradeoff against an equally valid path.

A decision is **not notable** when it is taste, color, icon, copy flavor, internal naming, or any of two equivalent implementations.

## Ask only at this gate

Ask only when **both** are true:

1. The fork would change the **perceived intent** of the request — what they asked for, not how it looks.
2. **And** at least one of:
   - Guessing wrong would waste material time or tokens versus the right fork (not a few seconds of polish).
   - The result cannot reasonably be undone by redoing the work or modifying what was completed.

If (1) is false, decide and continue.
If (1) is true but (2) is false, decide, continue, and log it.

When the gate fires:

- Ask **one** question.
- Name the intent-changing forks and why undo or cost makes a wrong guess expensive.
- Wait. Do not implement a guess while waiting.

A blocked item is not a reason to stop the whole request: park it, do every other item that does not depend on it, and raise the question once at the end with the rest of the work already finished.

## Forbidden mid-work

- Narration-only messages, status updates, progress summaries, and plan restatements
- Ending the turn because a subagent finished, or because an item finished
- Preference or taste questions
- Option menus for things you can decide
- "Want me to proceed?" / "Should I use X or Y?"
- Ending the turn to confirm a reversible choice

## Closeout

Only once `stokd autonomous status` shows nothing remaining. Present notable decisions as decisions already made — not as open questions:

```
## Decisions made
- Chose X over Y — <one-line why>
```

Omit the section if nothing was notable. Say plainly what was skipped and why, if anything was.
