import { runPrivilegedQuery } from "./privileged-runner.js";
import { CertificateInspectionSchema, type CertificateInspection } from "../shared/certificate-protocol.js";

export async function inspectInstalledCertificate(domain: string, invokingUid = process.getuid?.()): Promise<CertificateInspection> {
  if (!invokingUid || invokingUid === 0) throw new Error("certificate inspection must run as the non-root Pi service user");
  const response = await runPrivilegedQuery({ protocolVersion: 1, action: "inspect-certificate", invokingUid, domain }, "certificate inspection");
  return CertificateInspectionSchema.parse(JSON.parse(response));
}
