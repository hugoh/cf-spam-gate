import PostalMime from "postal-mime";
import { getClassifier } from "./classifier";
import { checkDnsbl } from "./dnsbl";
import { extractLinks } from "./links";
import { extractSenderIp } from "./received-header";
import { lookupRoute } from "./routing";
import {
  combineScores,
  contentScore,
  dnsblScore,
  headerScore,
  isSpam,
  type Scores,
  urlScore,
} from "./scoring";

export interface Env {
  ROUTES: KVNamespace;
  DEFAULT_THRESHOLD: string;
  SIGNAL_WEIGHTS: string;
  REJECT_MESSAGE: string;
  /** Optional: free Spamhaus DQS key. DNSBL check is skipped (scored neutral) when unset. */
  SPAMHAUS_DQS_KEY?: string;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const route = await lookupRoute(env.ROUTES, message.to);
    if (!route) {
      // No ROUTES entry means this address isn't meant to be handled by
      // this worker at all — misconfigured Email Routing rule, most likely.
      message.setReject("Recipient not configured");
      return;
    }

    const rawBuffer = await new Response(message.raw).arrayBuffer();
    const email = await PostalMime.parse(rawBuffer);

    const headerFrom = email.from?.address ?? message.from;

    const content = contentScore(
      getClassifier(),
      `${email.subject ?? ""}\n${email.text ?? email.html ?? ""}`,
    );

    const fromDomain = headerFrom.split("@")[1] ?? "";
    const url = urlScore(extractLinks(email.html, email.text), fromDomain);

    const header = headerScore({
      date: email.date,
      from: headerFrom,
      replyTo: email.replyTo?.[0]?.address,
      subject: email.subject,
    });

    const topReceived = email.headers.find(
      (h) => h.key.toLowerCase() === "received",
    )?.value;
    const senderIp = extractSenderIp(topReceived);
    const dnsblResult = await checkDnsbl(senderIp, env.SPAMHAUS_DQS_KEY);
    const dnsbl = dnsblScore(dnsblResult);

    const scores: Scores = { content, url, header, dnsbl };
    const weights = JSON.parse(env.SIGNAL_WEIGHTS) as Scores;
    const score = combineScores(scores, weights);
    const threshold = route.threshold ?? Number(env.DEFAULT_THRESHOLD);
    const spam = isSpam(score, threshold);

    console.log(
      JSON.stringify({
        to: message.to,
        from: headerFrom,
        subject: email.subject,
        senderIp,
        dnsblResult,
        scores,
        score,
        threshold,
        verdict: spam ? "reject" : "forward",
      }),
    );

    if (spam) {
      message.setReject(env.REJECT_MESSAGE);
      return;
    }

    for (const destination of route.destinations) {
      await message.forward(destination);
    }
  },
};
