import { Effect, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import * as path from 'node:path'

import { STORE } from './Evaluation.ts'

export class BuildPlanError extends Schema.TaggedError<BuildPlanError>()('BuildPlanError', {
  message: Schema.String,
}) {}

/**
 * What building a runner may not run.
 *
 * Confining the evaluation decides what nix reads and fetches while it
 * evaluates the layers. It says nothing about the derivations that evaluation
 * produces, and some of those reach the network when built: a fixed-output
 * derivation's builder is given the network, because nix checks its output by
 * hash instead; an impure derivation's is too; and `__noChroot` builds outside
 * the sandbox wherever the host relaxes it. Content can come from the
 * workspace, which the guest writes, so building one of these would let the
 * guest send anything evaluation can read to anywhere, whatever the project's
 * network policy.
 *
 * So igloo builds none of them. A fixed output that is already valid or
 * substitutable runs no builder, so it is never among the derivations a plan
 * would build. Anything else is for the developer to build, after reviewing it.
 */
export type Reason = 'fixed-output' | 'impure' | 'no-chroot'

export interface Refusal {
  readonly drvPath: string
  readonly reasons: readonly Reason[]
}

/**
 * Every derivation a dry run would build, from what it prints on stderr.
 *
 * nix gives the plan only as text: headings, each followed by indented store
 * paths. `--json` describes the installable's outputs, not the plan. Paths to
 * fetch are outputs rather than derivations, so every `.drv` line is taken,
 * whichever heading it is under, and a change to the headings' wording cannot
 * hide one.
 */
export const toBuild = (dryRun: string): Array<string> =>
  dryRun
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith(`${STORE}/`) && line.endsWith('.drv') && !/\s/.test(line))

const Derivation = Schema.Struct({
  env: Schema.Record(Schema.String, Schema.String),
  outputs: Schema.Record(
    Schema.String,
    Schema.Struct({
      hash: Schema.optionalKey(Schema.String),
      impure: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  structuredAttrs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})

/**
 * `nix derivation show`'s format version 4, which keys each derivation by its
 * store path's base name. Any other version is refused rather than guessed at,
 * because a field that moved would read as a derivation that is safe to build.
 */
const Shown = Schema.fromJsonString(
  Schema.Struct({
    derivations: Schema.Record(Schema.String, Derivation),
    version: Schema.Literal(4),
  }),
)

/**
 * Where nix records each reason. A fixed output carries its `hash`, which a
 * floating content-addressed output, built in the sandbox like any other, does
 * not. `__impure` is not kept in `env` but marks every output. `__noChroot`
 * stays where it was set: `env` as `"1"`, or `structuredAttrs` as `true` under
 * `__structuredAttrs`.
 */
const reasons = (derivation: typeof Derivation.Type): Array<Reason> => {
  const outputs = Object.values(derivation.outputs)
  return [
    ...(outputs.some(output => output.hash !== undefined) ? ['fixed-output' as const] : []),
    ...(outputs.some(output => output.impure === true) ? ['impure' as const] : []),
    ...(derivation.env['__noChroot'] === '1' || derivation.structuredAttrs?.['__noChroot'] === true
      ? ['no-chroot' as const]
      : []),
  ]
}

/** The derivations in `nix derivation show`'s output that igloo will not build. */
export const refused = Effect.fnUntraced(function* (shown: string) {
  const { derivations } = yield* Schema.decodeEffect(Shown)(shown).pipe(
    Effect.mapError(
      () =>
        new BuildPlanError({
          message:
            '`nix derivation show` printed something other than the version 4 JSON igloo reads, so what the build would run cannot be checked',
        }),
    ),
  )
  return Object.entries(derivations).flatMap(([name, derivation]): Array<Refusal> => {
    const found = reasons(derivation)
    return found.length === 0 ? [] : [{ drvPath: path.join(STORE, name), reasons: found }]
  })
})

const said: Record<Reason, string> = {
  'fixed-output': 'a fixed output, whose builder has the network',
  impure: 'impure, so its builder has the network',
  'no-chroot': '__noChroot, so it builds outside the sandbox',
}

/**
 * The refusal, naming every derivation and how the developer can build the
 * ones that can be built ahead. An impure one cannot: its output is never kept,
 * so it is built again wherever it is needed.
 */
export const describe = (refusals: readonly Refusal[]): string => {
  const buildable = refusals.filter(refusal => !refusal.reasons.includes('impure'))
  const one = refusals.length === 1
  const them = buildable.length === 1 ? 'it' : 'them'
  return [
    `this runner needs ${one ? 'a derivation' : `${String(refusals.length)} derivations`} built that can reach the network, which igloo does not build:`,
    '',
    ...refusals.map(
      refusal => `  ${refusal.drvPath}: ${refusal.reasons.map(reason => said[reason]).join('; ')}`,
    ),
    '',
    `Any layer may have added ${one ? 'it' : 'them'}, including a module from the workspace, which the guest can write. Review ${one ? 'it' : 'each'} with \`nix derivation show <drv>\`.`,
    ...(buildable.length === 0
      ? []
      : [
          `If you trust ${them}, build ${them} yourself and run \`igloo up\` again:`,
          '',
          '  nix build --no-link \\',
          ...buildable.map(
            (refusal, index) =>
              `    '${refusal.drvPath}^*'${index < buildable.length - 1 ? ' \\' : ''}`,
          ),
        ]),
    ...(buildable.length === refusals.length
      ? []
      : ['', 'An impure derivation cannot be built ahead, so it has to be removed instead.']),
  ].join('\n')
}

/** One nix command, keeping one of its streams as text. */
const run = Effect.fnUntraced(
  function* (nix: string, args: readonly string[], kept: 'stderr' | 'stdout') {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make(nix, args, {
        extendEnv: true,
        stderr: kept === 'stderr' ? 'pipe' : 'inherit',
        stdin: 'ignore',
        stdout: kept === 'stdout' ? 'pipe' : 'ignore',
      }),
    )
    const text = yield* (kept === 'stdout' ? handle.stdout : handle.stderr).pipe(
      Stream.decodeText,
      Stream.mkString,
    )
    return { code: yield* handle.exitCode, text }
  },
  Effect.scoped,
  Effect.mapError(() => new BuildPlanError({ message: 'cannot run nix to check the build plan' })),
)

/**
 * What building `drvPath` would run that igloo refuses, from nix's own plan.
 *
 * The plan, not the closure: a derivation whose output is valid or can be
 * fetched runs no builder, and a NixOS system's closure has thousands of
 * those.
 *
 * The plan is text nix does not promise to keep, so it is checked against what
 * it must contain. A runner that is not built yet is itself among the
 * derivations to build. A plan without it, for a runner that is not built
 * either, is one this did not read, and the launch stops there rather than
 * building what nobody checked.
 */
export const check = Effect.fnUntraced(function* (nix: string, drvPath: string) {
  const dryRun = yield* run(nix, ['build', '--dry-run', `${drvPath}^*`], 'stderr')
  if (dryRun.code !== 0) {
    const reason = dryRun.text.trim().split('\n').at(-1) ?? ''
    return yield* new BuildPlanError({
      message: `nix build --dry-run exited ${String(dryRun.code)}${reason === '' ? '' : `: ${reason}`}`,
    })
  }
  const planned = toBuild(dryRun.text)

  if (!planned.includes(drvPath)) {
    const built = yield* run(nix, ['path-info', `${drvPath}^*`], 'stderr')
    if (built.code !== 0) {
      return yield* new BuildPlanError({
        message: `nix's dry run did not list ${drvPath}, which is not built either, so it printed its plan in a form igloo does not read and what the build would run cannot be checked`,
      })
    }
  }
  if (planned.length === 0) return []

  const shown = yield* run(nix, ['derivation', 'show', ...planned], 'stdout')
  if (shown.code !== 0) {
    return yield* new BuildPlanError({
      message: `nix derivation show exited ${String(shown.code)}`,
    })
  }
  return yield* refused(shown.text)
})
