# Linux Server Setup — Enabling Memory Overcommit for Redis

This guide explains how to resolve the Redis startup warning observed in Linux / Docker / Dokploy deployment logs by enabling kernel memory overcommit (`vm.overcommit_memory = 1`) on the host machine.

---

## 1. Symptoms in Deployment Logs

When starting the `faixasegura-redis` container on a Linux VPS or Dokploy host where memory overcommit is set to the default heuristic mode (`0`), Redis logs the following warning on startup:

```text
# WARNING Memory overcommit must be enabled! Without it, a background save or replication may fail under low memory condition. Being disabled, it can also cause failures without low memory condition, see https://github.com/jemalloc/jemalloc/issues/1328. To fix this issue add 'vm.overcommit_memory = 1' to /etc/sysctl.conf and then reboot or run the command 'sysctl vm.overcommit_memory=1' for this to take effect.
```

### Why This Happens

1. **Copy-on-Write (`fork`) & `jemalloc` Allocations**: Redis relies on POSIX `fork()` for background persistence/replication and uses the `jemalloc` allocator. When `vm.overcommit_memory` is `0`, the Linux kernel may reject virtual memory allocations or `madvise`/`mmap` operations even when plenty of physical RAM is free (see `jemalloc` issue `#1328`).
2. **Host Kernel Scope (Docker Limitation)**: `vm.overcommit_memory` is a **non-namespaced Linux kernel parameter**. Unprivileged Docker containers cannot override `vm.*` sysctls inside `docker-compose.yml` (`sysctl` writes to `/proc/sys/vm/overcommit_memory` inside a container fail with `Read-only file system` or `invalid argument`). Therefore, this setting **must be applied on the Linux host OS** via SSH.

---

## 2. Step-by-Step Fix on the Linux Host

Connect to your Linux server (Ubuntu, Debian, RHEL, Rocky, AlmaLinux, etc.) via SSH with `sudo` or `root` privileges and follow these steps.

### Step 1: Check the Current Kernel Setting

```bash
sysctl vm.overcommit_memory
```

If the output is `vm.overcommit_memory = 0`, memory overcommit is not yet enabled.

### Step 2: Persist `vm.overcommit_memory = 1` in `/etc/sysctl.conf`

Add `vm.overcommit_memory = 1` to `/etc/sysctl.conf` so the setting survives server reboots. The command below updates an existing entry if present, or appends it safely if missing:

```bash
if grep -qE '^\s*vm\.overcommit_memory\s*=' /etc/sysctl.conf 2>/dev/null; then
  sudo sed -i 's/^\s*vm\.overcommit_memory\s*=.*/vm.overcommit_memory = 1/' /etc/sysctl.conf
else
  echo 'vm.overcommit_memory = 1' | sudo tee -a /etc/sysctl.conf
fi
```

> **Note for newer systemd distributions (Ubuntu 24.04+ / Debian 13+)**: Some minimal cloud images ignore `/etc/sysctl.conf` unless `/etc/sysctl.d/99-sysctl.conf` symlinks to it. To guarantee persistence across all systemd versions, you can also mirror the setting in `/etc/sysctl.d/`:
>
> ```bash
> echo 'vm.overcommit_memory = 1' | sudo tee /etc/sysctl.d/99-redis-overcommit.conf
> ```

### Step 3: Apply the Setting Immediately (No Reboot Required)

Reload `/etc/sysctl.conf` and apply the runtime kernel parameter immediately:

```bash
sudo sysctl -p /etc/sysctl.conf
sudo sysctl vm.overcommit_memory=1
```

*(If you also created `/etc/sysctl.d/99-redis-overcommit.conf`, you can run `sudo sysctl --system` to reload all sysctl configuration files.)*

### Step 4: Verify the Active Value

Confirm that the kernel now reports `1`:

```bash
sysctl vm.overcommit_memory
# Expected output:
# vm.overcommit_memory = 1

cat /proc/sys/vm/overcommit_memory
# Expected output:
# 1
```

### Step 5: Restart Redis and Verify Clean Logs

Restart the Redis service (either from your Dokploy compose directory or local Docker Compose project) so Redis re-checks the kernel setting at startup:

```bash
docker compose restart faixasegura-redis
docker compose logs --tail=30 faixasegura-redis
```

The `# WARNING Memory overcommit must be enabled!` message will no longer appear in the container logs.

---

## 3. Built-In Container Mitigations in FaixaSegura

Even before you apply the host-level `sysctl` change above, `docker-compose.yml` configures `faixasegura-redis` defensively as a bounded in-memory LRU cache:

```yaml
command: redis-server --save "" --appendonly no --maxmemory 128mb --maxmemory-policy allkeys-lru --stop-writes-on-bgsave-error no --loglevel warning
```

- `--save ""` and `--appendonly no`: Disables RDB and AOF background `fork()` disk snapshots since Redis is used strictly as a TTL cache.
- `--maxmemory 128mb --maxmemory-policy allkeys-lru`: Caps memory usage deterministically and evicts least-recently-used cache keys.
- `--stop-writes-on-bgsave-error no`: Prevents Redis from rejecting cache writes if background persistence is ever triggered manually.

Applying `vm.overcommit_memory = 1` on the Linux host complements these container flags, resolves the `jemalloc` virtual memory caveat completely, and keeps production logs clean.

---

## 4. Reference Values for `vm.overcommit_memory`

| Value | Kernel Mode | Behavior |
| :--- | :--- | :--- |
| `0` | Heuristic overcommit *(Linux default)* | Kernel estimates available memory heuristically; triggers the Redis / `jemalloc` startup warning. |
| `1` | **Always overcommit *(Recommended for Redis)*** | Kernel permits virtual memory allocations needed by `fork()` copy-on-write pages and `jemalloc` arenas. |
| `2` | Strict no-overcommit | Kernel refuses allocations exceeding swap + a ratio of physical RAM; unsuitable for Redis hosts. |
