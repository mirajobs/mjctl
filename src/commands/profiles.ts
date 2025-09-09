import { Command } from "commander";
import { Confirm } from "../lib/prompt";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import * as api from "../lib/api";
import type { Profile } from "../lib/api";
import { parse as parseYaml } from "yaml";
import { cfg } from "../lib/config";
import { log } from "../lib/log";

type ListOpts = { json?: boolean };
type CreateOpts = { fromResume?: string; title?: string; out?: string };
type LoadOpts = { out?: string; force?: boolean };
type SaveOpts = { validateOnly?: boolean; yes?: boolean };
type DeleteOpts = { yes?: boolean };

type ResumeUpload = { filename: string; content: string; encoding: "base64" };
type CreatePayload = { Title?: string; Resume?: ResumeUpload } & Record<string, unknown>;

// Minimal local validation helper.
function validateProfilePayload(payload: unknown) {
  const errors: string[] = [];
  if (!payload || typeof payload !== "object") {
    errors.push("Payload must be an object");
  }

  const obj = payload as Record<string, unknown>;
  if (!obj.ProfileID || typeof obj.ProfileID !== "string") {
    errors.push("Missing required field: ProfileID (string)");
  }

  if (!obj.Title || typeof obj.Title !== "string") {
    errors.push("Missing required field: title (string)");
  }

  // TODO: add more field checks as needed

  return errors;
}

const profiles = new Command("profiles")
  .description("Manage profiles")
  .action(function (this: Command) {
    this.outputHelp();
  });

profiles
  .command("list")
  .description("List profiles (human table). Use --json for raw output")
  .option("--json", "Print raw JSON")
  .action(async (opts: ListOpts) => {
    try {
      const profiles: Profile[] = await api.listProfiles();
      if (opts.json) {
        log.info(JSON.stringify(profiles, null, 2));
        return;
      }
      if (!Array.isArray(profiles) || profiles.length === 0) {
        log.info("No profiles found.");
        log.info(
          `Create one with:\n` +
            `  - ${cfg.appName} profiles create --title "Senior Developer"\n` +
            `  - ${cfg.appName} profiles create --from-resume ./resume.pdf --title "Senior Developer"`,
        );
        return;
      }
      const rows = profiles.map((p: Profile, i: number) => {
        const id = p.ProfileID || "-";
        const title = p.Title || "(no title)";
        const category = p.Category || "-";
        const ShortUrl = p.ShortUrl || "-";
        const visibility = p.Visibility || "-";
        const created = p.Created || "-";
        return [
          `${i + 1}. ${id}`,
          title,
          category,
          `[${ShortUrl}]`,
          visibility,
          created.split("T")[0],
        ].join("  ");
      });
      log.info("Profiles:\n" + rows.join("\n"));
    } catch (e: unknown) {
      log.error("Failed to list profiles:", e instanceof Error ? e.message : String(e));
    }
  });

profiles
  .command("create")
  .description(
    "Create a new jobseeker's profile",
  )
  .option(
    "-r, --from-resume <path:string>",
    "Generate a profile from a resume file using server-side AI",
  )
  .option(
    "-t, --title <title:string>",
    "Provide profile title i.e. Senior Front-End Developer",
  )
  .option(
    "-o, --out <path:string>",
    "Output path for profile YAML file",
  )
  .action(async (opts: CreateOpts) => {
    // Enforce title when no resume is provided.
    if (!opts.fromResume && !opts.title) {
      log.error("The --title option is required when --from-resume is not provided.");
      return;
    }

    const payload: CreatePayload = {
      Title: opts.title,
    };

    if (opts.fromResume) {
      try {
        const resumePath = path.resolve(opts.fromResume);
        const bytes = await fs.readFile(resumePath);
        const resumeContent = bytes.toString("base64");
        payload.Resume = {
          filename: path.basename(resumePath),
          content: resumeContent,
          encoding: "base64",
        };
      } catch (e: unknown) {
        log.error("Failed to read resume file:", e instanceof Error ? e.message : String(e));
        return;
      }
    }

    let profile: Profile;
    try {
      profile = await api.createProfile(payload);
      log.info(`Created profile on server: ${profile.ProfileID || "(unknown)"}`);
    } catch (e: unknown) {
      log.error("Create profile failed:", e instanceof Error ? e.message : String(e));
      return;
    }

    const out = opts.out || `./profile-${profile.ProfileID}.yaml`;
    const outFile = path.resolve(out);
    try {
      await fs.writeFile(outFile, String(profile.Yaml ?? ""), { encoding: "utf8" });
      try {
        await fs.chmod(outFile, 0o600);
      } catch { /* ignore chmod errors */ }
      log.info(`Saved created profile draft to ${outFile}`);
    } catch (writeErr) {
      log.error("Failed to save created profile locally:", writeErr);
    }

    log.info(
      `Next steps: edit the file in your editor, then run: ${cfg.appName} profiles save <path>`,
    );
  });

profiles
  .command("load <identifier:string>")
  .description("Download an existing profile to a local YAML file")
  .description(" for editing")
  .option(
    "--out <path:string>",
    "Output file path",
  )
  .option(
    "-f, --force",
    "Overwrite existing file",
  )
  .action(async (opts: LoadOpts, identifier: string) => {
    try {
      const profile: Profile | null = await api.getProfile(identifier);
      if (!profile) {
        log.error("Profile not found.");
        return;
      }
      const out = opts.out || `./profile-${(profile.ProfileID || "unknown")}.yaml`;
      const resolved = path.resolve(out);
      if (!opts.force) {
        try {
          await fs.stat(resolved);
          log.error(`File already exists: ${resolved} (use --force to overwrite)`);
          return;
        } catch {
          // file does not exist -> continue
        }
      }
      await fs.writeFile(resolved, String(profile.Yaml ?? ""), { encoding: "utf8" });
      try {
        await fs.chmod(resolved, 0o600);
      } catch { /* ignore chmod errors */ }
      log.info(`Downloaded profile to ${resolved}`);
      log.info(`Edit the file and then run: ${cfg.appName} profiles save <path>`);
    } catch (e: unknown) {
      log.error("Failed to download profile:", e instanceof Error ? e.message : String(e));
    }
  });

profiles
  .command("save <fileOrId:string>")
  .description(
    "Validate a local profile file (path) or profile ID and save it to the server. If an alphanumeric ID is provided, the file is resolved as ./profile-{ID}.yaml.",
  )
  .option(
    "--validate-only",
    "Validate locally but do not upload",
  )
  .option(
    "-y, --yes",
    "Skip confirmation",
  )
  .action(async (opts: SaveOpts, fileOrId: string) => {
    try {
      const input = fileOrId;
      const filePath = /^[A-Za-z0-9]+$/.test(input)
        ? path.resolve(`./profile-${input}.yaml`)
        : path.resolve(input);

      const raw = await fs.readFile(filePath, { encoding: "utf8" });

      // Parse YAML into a JS object before validation/upload
      let payload: unknown;
      try {
        payload = parseYaml(raw);
      } catch (e: unknown) {
        log.error("Failed to parse YAML:", e instanceof Error ? e.message : String(e));
        return;
      }

      const errors = validateProfilePayload(payload);
      if (errors.length > 0) {
        log.error("Local validation errors:");
        for (const err of errors) log.error(" -", err);
        return;
      }

      if (opts.validateOnly) {
        log.info("Validation successful (--validate-only). No upload performed.");
        return;
      }

      const pobj = payload as Record<string, unknown>;
      const summary = `Title: ${String(pobj.Title ?? "(no title)")}  ID: ${
        String(pobj.ProfileID ?? "(new)")
      }`;
      if (!opts.yes) {
        const ok = await Confirm.prompt({ message: `Upload profile? ${summary}` });
        if (!ok) {
          log.info("Aborted by user.");
          return;
        }
      }

      if (pobj.ProfileID) {
        const res: Profile = await api.updateProfile(String(pobj.ProfileID), pobj);
        log.info(`Updated profile: ${res.ProfileID}`);

        // Check location fields on the returned Profile object
        {
          const missing: string[] = [];
          const r = res as unknown as {
            CountryCode?: unknown;
            RegionID?: unknown;
            CityID?: unknown;
          };
          if (r.CountryCode == null) missing.push("CountryCode");
          if (r.RegionID == null) missing.push("RegionID");
          if (r.CityID == null) missing.push("CityID");
          if (missing.length > 0) {
            log.warn(
              `Location is set on your user account and shared among all your profiles. ` +
                `It appears incomplete (${missing.join(", ")} not set). ` +
                `Set it via: ${cfg.appName} location set`,
            );
          }
        }
      } else {
        throw new Error(
          "ProfileID is required in payload to perform update. Use 'create' to create a new profile.",
        );
      }
    } catch (e: unknown) {
      log.error("Failed to update profile:", e instanceof Error ? e.message : String(e));
    }
  });

profiles
  .command("delete <identifier:string>")
  .description("Delete a profile")
  .option(
    "-y, --yes",
    "Skip confirmation",
  )
  .action(async (opts: DeleteOpts, identifier: string) => {
    try {
      if (!opts.yes) {
        const ok = await Confirm.prompt({ message: `Delete profile ${identifier}?` });
        if (!ok) {
          log.info("Aborted by user.");
          return;
        }
      }
      await api.deleteProfile(identifier);
      log.info(`Profile ${identifier} deleted.`);
    } catch (e: unknown) {
      log.error("Failed to delete profile:", e instanceof Error ? e.message : String(e));
    }
  });

export const profilesCommand = profiles;
export default profilesCommand;
