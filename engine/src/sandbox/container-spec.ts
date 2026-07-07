import { config } from "../config.js";

/**
 * Declarative description of how a sandbox container should be launched.
 *
 * Consumed by `run-under-observation.ts` (via `specToDockerArgs`), which
 * launches the sandbox for the experimenter worker. Manipulation primitives
 * and sensors contribute additional fields (envs, volumes, capAdd, ldPreload).
 */
export interface ContainerSpec {
  image: string;
  memory: string;       // e.g. "512m"
  cpus: number;
  networkMode: string;  // "none" | "bridge" | custom network

  envs: Record<string, string>;
  volumes: VolumeMount[];
  capAdd: string[];
  capDrop: string[];    // default: ["ALL"]
  readOnly: boolean;    // read-only rootfs
  tmpfs: TmpfsMount[];
  pidsLimit: number;
  user: string;         // "uid:gid"
  preload: string | null;     // NODE_OPTIONS=--require <preload>
  ldPreload: string | null;   // LD_PRELOAD=<path>
  hostname: string | null;
  workdir: string;
  publishPorts: PortMapping[];
}

export interface PortMapping {
  hostPort: number;
  containerPort: number;
  hostAddress?: string; // defaults to 127.0.0.1
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export interface TmpfsMount {
  path: string;
  options: string; // e.g. "rw,noexec,nosuid,size=64m"
}

/** Defaults mirror the current DockerSandboxController lockdown settings. */
export function defaultContainerSpec(partial: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    image: config.sandboxImage,
    memory: `${config.sandboxMemoryMb}m`,
    cpus: config.sandboxCpus,
    networkMode: config.sandboxNetwork,
    envs: {},
    volumes: [],
    capAdd: [],
    capDrop: ["ALL"],
    readOnly: true,
    tmpfs: [{ path: "/tmp", options: "rw,noexec,nosuid,size=64m" }],
    pidsLimit: 64,
    user: "1000:1000",
    preload: null,
    ldPreload: null,
    hostname: null,
    workdir: "/pkg",
    publishPorts: [],
    ...partial,
  };
}

/**
 * Translate a ContainerSpec into `docker run` CLI arguments (without the
 * trailing image + command, which callers append themselves).
 *
 * Keeps translation logic in one place so the controller refactor in Sprint 4
 * and manipulation primitives in Sprint 3 can evolve the spec without
 * rewriting launch code.
 */
export function specToDockerArgs(spec: ContainerSpec, containerName: string): string[] {
  const args: string[] = ["run", "-d", "--name", containerName, `--network=${spec.networkMode}`];

  for (const cap of spec.capDrop) args.push(`--cap-drop=${cap}`);
  for (const cap of spec.capAdd) args.push(`--cap-add=${cap}`);

  if (spec.readOnly) args.push("--read-only");
  args.push(`--memory=${spec.memory}`, `--cpus=${spec.cpus}`);
  args.push("--user", spec.user);
  args.push("--pids-limit", String(spec.pidsLimit));

  for (const tmpfs of spec.tmpfs) {
    args.push("--tmpfs", `${tmpfs.path}:${tmpfs.options}`);
  }

  for (const [key, value] of Object.entries(spec.envs)) {
    args.push("-e", `${key}=${value}`);
  }

  if (spec.preload) {
    const existing = spec.envs["NODE_OPTIONS"];
    const nodeOpts = existing
      ? `${existing} --require ${spec.preload}`
      : `--require ${spec.preload}`;
    args.push("-e", `NODE_OPTIONS=${nodeOpts}`);
  }

  if (spec.ldPreload) {
    args.push("-e", `LD_PRELOAD=${spec.ldPreload}`);
  }

  if (spec.hostname) {
    args.push("--hostname", spec.hostname);
  }

  for (const vol of spec.volumes) {
    const ro = vol.readOnly ? ":ro" : "";
    args.push("-v", `${vol.hostPath}:${vol.containerPath}${ro}`);
  }

  for (const port of spec.publishPorts) {
    const host = port.hostAddress ?? "127.0.0.1";
    args.push("-p", `${host}:${port.hostPort}:${port.containerPort}`);
  }

  args.push("-w", spec.workdir);
  args.push(spec.image);
  args.push("sleep", "infinity");

  return args;
}
