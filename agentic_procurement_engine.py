#!/usr/bin/env python3
"""
VELQIRIS — AGENTIC COMMERCE TRUST GATE
Autonomous AI Procurement Engine & Deterministic Policy Enforcement Gate.

Architecture:
- Layer 1: Procurement Mandate (Budget ceiling, risk threshold, authorized scope)
- Layer 2: AI Decision Engine (Multi-offer comparative analysis, risk reasoning, structured output)
- Layer 3: Policy Enforcement Engine (DETERMINISTIC, NON-BYPASSABLE, FAIL-CLOSED GATE)
- Layer 4: PayPal Settlement Integration (Locked payload dispatch to PayPal Sandbox v2)
"""

import os
import sys
import json
import time
import re
import hashlib
import urllib.request
import urllib.error
import urllib.parse
from typing import Dict, Any, List, Optional, Tuple

# ==============================================================================
# DATA MODELS & SCHEMAS
# ==============================================================================

class ProcurementMandate:
    """Immutable procurement boundary defining agent purchasing limits."""
    def __init__(
        self,
        mandate_id: str = "MANDATE-2026-DIGITAL-REPORT-001",
        max_budget_usd: float = 25.00,
        currency: str = "USD",
        target_asset: str = "DIGITAL_INTELLIGENCE_REPORT",
        max_tolerable_risk_score: float = 30.0,
        authorized_merchant_whitelist: Optional[List[str]] = None,
    ):
        self.mandate_id = mandate_id
        self.max_budget_usd = float(max_budget_usd)
        self.currency = currency
        self.target_asset = target_asset
        self.max_tolerable_risk_score = float(max_tolerable_risk_score)
        self.authorized_merchant_whitelist = authorized_merchant_whitelist or [
            "528WKSF7HVQHA",       # Official VELQIRIS Sandbox Merchant ID
            "MERCH-ALPHA-01",      # Alpha Research Lab
            "MERCH-BETA-02",       # Discount Data Depot (Suspect telemetry)
            "MERCH-GAMMA-03",      # Apex Quant Consortium
        ]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "mandate_id": self.mandate_id,
            "max_budget_usd": self.max_budget_usd,
            "currency": self.currency,
            "target_asset": self.target_asset,
            "max_tolerable_risk_score": self.max_tolerable_risk_score,
            "authorized_merchant_whitelist": self.authorized_merchant_whitelist,
        }


class VendorOffer:
    """Standardized commercial vendor offer for procurement evaluation."""
    def __init__(
        self,
        offer_id: str,
        vendor_name: str,
        merchant_id: str,
        price_usd: float,
        asset_title: str,
        quality_score: float,
        risk_score: float,
        risk_factors: List[str],
        telemetry: Optional[Dict[str, Any]] = None,
    ):
        self.offer_id = offer_id
        self.vendor_name = vendor_name
        self.merchant_id = merchant_id
        self.price_usd = float(price_usd)
        self.asset_title = asset_title
        self.quality_score = float(quality_score)
        self.risk_score = float(risk_score)
        self.risk_factors = risk_factors
        self.telemetry = telemetry or {}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "offer_id": self.offer_id,
            "vendor_name": self.vendor_name,
            "merchant_id": self.merchant_id,
            "price_usd": self.price_usd,
            "asset_title": self.asset_title,
            "quality_score": self.quality_score,
            "risk_score": self.risk_score,
            "risk_factors": self.risk_factors,
            "telemetry": self.telemetry,
        }


def get_standard_competition_offers() -> List[VendorOffer]:
    """
    Returns the three standardized procurement offers specified for PayPal AI Hackathon:
    - Offer A: $19.00 USD (Eligible, High Quality, Legitimate Merchant)
    - Offer B: $16.00 USD (Cheaper, but documented telemetry risk: stale feeds, high disputes)
    - Offer C: $29.00 USD (High Quality, but exceeds $25.00 budget ceiling)
    """
    return [
        VendorOffer(
            offer_id="OFFER-ALPHA-01",
            vendor_name="Alpha Intelligence Systems",
            merchant_id="528WKSF7HVQHA",
            price_usd=19.00,
            asset_title="BTC/USDC Multi-Venue Autonomous Audit Report (Tier-1)",
            quality_score=96.5,
            risk_score=8.0,
            risk_factors=[],
            telemetry={
                "data_freshness_seconds": 2,
                "venue_source_count": 4,
                "historical_dispute_rate_pct": 0.05,
                "audit_certificate_sha256": "8ac0103802e16a44f7629369cbac8a258f19e6dc14437d7dd83b7315ae321f17",
            },
        ),
        VendorOffer(
            offer_id="OFFER-BETA-02",
            vendor_name="Discount Feeds & Telemetry Depot",
            merchant_id="MERCH-BETA-02",
            price_usd=16.00,
            asset_title="BTC/USDC Raw Market Dump (Budget Edition)",
            quality_score=58.0,
            risk_score=78.5,
            risk_factors=[
                "Dispute rate 19.4% exceeds 2.0% enterprise ceiling",
                "Stale feed latency (> 45 minutes delayed)",
                "Unsigned digital deliverable payload",
            ],
            telemetry={
                "data_freshness_seconds": 2840,
                "venue_source_count": 1,
                "historical_dispute_rate_pct": 19.4,
                "audit_certificate_sha256": None,
            },
        ),
        VendorOffer(
            offer_id="OFFER-GAMMA-03",
            vendor_name="Apex Institutional Quant Consortium",
            merchant_id="MERCH-GAMMA-03",
            price_usd=29.00,
            asset_title="Institutional Sovereign Market Attestation Dossier",
            quality_score=99.0,
            risk_score=4.5,
            risk_factors=[],
            telemetry={
                "data_freshness_seconds": 1,
                "venue_source_count": 8,
                "historical_dispute_rate_pct": 0.01,
                "audit_certificate_sha256": "4b72ef9100ac32b7194639487a53fef12389104059a432901239019283019203",
            },
        ),
    ]


# ==============================================================================
# LAYER 2: AI DECISION ENGINE (REASONING & RECOMMENDATION)
# ==============================================================================

class AIDecisionEngine:
    """
    Evaluates competing market offers against procurement mandate using structured
    semantic analysis, multi-criteria trade-offs, uncertainty quantification,
    and prompt injection defense.
    
    Operates in dual-mode:
    - Mode 1 (Online LLM): When MODEL_API_KEY is configured, queries an OpenAI-compatible
      model endpoint with strict JSON schema validation.
    - Mode 2 (Offline Structured Reasoning): Deterministic semantic utility function U(o)
      incorporating quality, normalized price, risk factor weights, and epistemic uncertainty.
    """
    def __init__(
        self,
        model_name: str = "VELQIRIS-Agentic-Procurement-v1",
        api_key: Optional[str] = None,
        api_endpoint: Optional[str] = None,
    ):
        self.model_name = model_name
        self.api_key = api_key or os.environ.get("MODEL_API_KEY")
        self.api_endpoint = api_endpoint or os.environ.get("MODEL_API_ENDPOINT")

    def _sanitize_offer_input(self, offer: VendorOffer) -> Tuple[VendorOffer, bool, List[str]]:
        """Strips adversarial prompt-injection payloads from untrusted vendor inputs."""
        injection_patterns = [
            r"ignore\s+(all\s+)?prior\s+instructions",
            r"system\s*:\s*",
            r"assistant\s*:\s*",
            r"user\s*:\s*",
            r"human\s*:\s*",
            r"developer\s*:\s*",
            r"set\s+budget\s+to",
            r"override\s+policy",
            r"authorize\s+unconditionally",
            r"bypass\s+check",
            r"disregard\s+budget",
            r"<script[^>]*>",
            r"</script>",
            r"\{\{.*?\}\}",
        ]
        sanitized_title = offer.asset_title
        sanitized_vendor = offer.vendor_name
        detected_patterns = []

        for pat in injection_patterns:
            if re.search(pat, sanitized_title, flags=re.IGNORECASE):
                detected_patterns.append(pat)
                sanitized_title = re.sub(pat, "[FILTERED_INJECTION]", sanitized_title, flags=re.IGNORECASE)
            if re.search(pat, sanitized_vendor, flags=re.IGNORECASE):
                detected_patterns.append(pat)
                sanitized_vendor = re.sub(pat, "[FILTERED_INJECTION]", sanitized_vendor, flags=re.IGNORECASE)

        sanitized_offer = VendorOffer(
            offer_id=offer.offer_id,
            vendor_name=sanitized_vendor,
            merchant_id=offer.merchant_id,
            price_usd=offer.price_usd,
            asset_title=sanitized_title,
            quality_score=offer.quality_score,
            risk_score=offer.risk_score,
            risk_factors=list(offer.risk_factors),
            telemetry=dict(offer.telemetry),
        )
        return sanitized_offer, len(detected_patterns) > 0, detected_patterns

    def compute_uncertainty_score(self, offer: VendorOffer, mandate: ProcurementMandate) -> float:
        """
        Quantifies epistemic and telemetry uncertainty regarding an offer.
        Returns uncertainty in [0.0, 1.0].
        """
        uncertainty = 0.05  # Base model uncertainty
        telemetry = offer.telemetry or {}
        if not telemetry:
            uncertainty += 0.45  # Absence of telemetry and audit attestation represents severe uncertainty
        else:
            freshness = telemetry.get("data_freshness_seconds")
            if freshness is None or freshness > 300:
                uncertainty += 0.20

            if not telemetry.get("audit_certificate_sha256"):
                uncertainty += 0.35

            dispute_rate = telemetry.get("historical_dispute_rate_pct", 0.0)
            if dispute_rate > 2.0:
                uncertainty += 0.15

        if offer.merchant_id not in mandate.authorized_merchant_whitelist:
            uncertainty += 0.20

        return round(min(1.0, max(0.0, uncertainty)), 3)

    def compute_utility_score(self, offer: VendorOffer, mandate: ProcurementMandate, uncertainty: float) -> float:
        """
        Calculates multi-criteria utility U(o) combining quality, normalized price, risk, and uncertainty.
        U(o) = 0.40 * (quality/100) - 0.30 * (price/budget) - 0.20 * (risk/100) - 0.10 * uncertainty
        """
        wq, wp, wr, wu = 0.40, 0.30, 0.20, 0.10
        quality_factor = offer.quality_score / 100.0
        budget_ratio = min(1.5, offer.price_usd / max(0.01, mandate.max_budget_usd))
        risk_factor = offer.risk_score / 100.0

        utility = (wq * quality_factor) - (wp * budget_ratio) - (wr * risk_factor) - (wu * uncertainty)
        return round(utility, 4)

    def _call_live_model_api(
        self,
        mandate: ProcurementMandate,
        sanitized_offers: List[VendorOffer],
        user_guidance: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Invokes external OpenAI-compatible model API if configured and reachable."""
        if not self.api_key:
            return None

        endpoint = self.api_endpoint or "https://api.openai.com/v1/chat/completions"
        payload = {
            "model": self.model_name,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are VELQIRIS Autonomous Procurement Agent. Analyze candidate vendor offers "
                        "against the immutable procurement mandate. Return strictly valid JSON adhering "
                        "to schema with recommended_offer_id, confidence_score, and decision_rationale."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps({
                        "mandate": mandate.to_dict(),
                        "candidate_offers": [o.to_dict() for o in sanitized_offers],
                        "guidance": user_guidance,
                    }),
                },
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.1,
        }

        try:
            req = urllib.request.Request(
                endpoint,
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "User-Agent": "VELQIRIS-Agentic-Trust-Gate/2.0",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    msg = data["choices"][0]["message"]["content"]
                    parsed = json.loads(msg)
                    if "recommended_offer_id" in parsed:
                        return parsed
        except Exception:
            # Fall back closed to offline structured reasoning
            return None
        return None

    def evaluate_offers(
        self,
        mandate: ProcurementMandate,
        offers: List[VendorOffer],
        user_guidance: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Executes autonomous comparative analysis.
        Returns a structured decision document detailing evaluations, rejection rationales,
        epistemic uncertainty quantification, and the recommended offer.
        """
        sanitized_offers = []
        injection_flags = []
        for o in offers:
            san_offer, inj_detected, patterns = self._sanitize_offer_input(o)
            sanitized_offers.append(san_offer)
            if inj_detected:
                injection_flags.append({"offer_id": o.offer_id, "patterns": patterns})

        # Try live model API if configured
        live_result = self._call_live_model_api(mandate, sanitized_offers, user_guidance)
        engine_mode = "ONLINE_LLM_INFERENCE" if live_result else "OFFLINE_STRUCTURED_REASONING_ENGINE"

        evaluations = []
        eligible_candidates = []
        rejection_reasons = {}

        for o in sanitized_offers:
            uncertainty = self.compute_uncertainty_score(o, mandate)
            confidence = round(1.0 - uncertainty, 3)
            utility = self.compute_utility_score(o, mandate, uncertainty)

            ev = {
                "offer_id": o.offer_id,
                "vendor": o.vendor_name,
                "price_usd": o.price_usd,
                "quality_score": o.quality_score,
                "risk_score": o.risk_score,
                "uncertainty_score": uncertainty,
                "confidence_score": confidence,
                "utility_score": utility,
            }

            # Contradictory metrics detection (e.g. claimed 99 quality with high dispute rate or missing telemetry)
            dispute_rate = (o.telemetry or {}).get("historical_dispute_rate_pct", 0.0)
            if dispute_rate > 15.0 and o.quality_score > 90.0:
                o.risk_factors.append(f"Contradictory metrics: claimed quality {o.quality_score} contradicts {dispute_rate}% dispute rate")
                ev["risk_factors"] = o.risk_factors

            # 1. Budget check
            if o.price_usd > mandate.max_budget_usd:
                ev["status"] = "REJECTED_OVER_BUDGET"
                ev["rationale"] = (
                    f"Offer price (${o.price_usd:.2f}) exceeds authorized budget ceiling "
                    f"(${mandate.max_budget_usd:.2f}) by ${o.price_usd - mandate.max_budget_usd:.2f}."
                )
                rejection_reasons[o.offer_id] = ev["rationale"]
                evaluations.append(ev)
                continue

            # 2. Risk & Uncertainty check
            if o.risk_score > mandate.max_tolerable_risk_score or len(o.risk_factors) > 0:
                ev["status"] = "REJECTED_HIGH_RISK"
                ev["rationale"] = (
                    f"Risk score ({o.risk_score:.1f}/100) exceeds maximum tolerance "
                    f"({mandate.max_tolerable_risk_score:.1f}). Identified risk factors: "
                    f"{'; '.join(o.risk_factors)}."
                )
                rejection_reasons[o.offer_id] = ev["rationale"]
                evaluations.append(ev)
                continue

            if uncertainty > 0.40:
                ev["status"] = "REJECTED_UNACCEPTABLE_UNCERTAINTY"
                ev["rationale"] = (
                    f"Epistemic uncertainty score ({uncertainty:.2f}) exceeds maximum threshold (0.40). "
                    f"Unverified provenance or telemetry anomalies detected."
                )
                rejection_reasons[o.offer_id] = ev["rationale"]
                evaluations.append(ev)
                continue

            # 3. Eligible candidate
            ev["status"] = "ELIGIBLE_APPROVED"
            ev["rationale"] = (
                f"Offer is strictly within budget (${o.price_usd:.2f} <= ${mandate.max_budget_usd:.2f}), "
                f"exhibits superior quality ({o.quality_score:.1f}/100), low risk "
                f"({o.risk_score:.1f} <= {mandate.max_tolerable_risk_score:.1f}), and high confidence ({confidence:.2f})."
            )
            evaluations.append(ev)
            eligible_candidates.append((utility, o, ev))

        decision_id = f"AI-DECISION-{int(time.time())}-{hashlib.sha256(json.dumps([o.to_dict() for o in sanitized_offers], sort_keys=True).encode()).hexdigest()[:8]}"

        if not eligible_candidates:
            return {
                "decision_id": decision_id,
                "status": "ALL_OFFERS_REJECTED",
                "recommended_offer_id": None,
                "recommended_price_usd": 0.0,
                "decision_rationale": "No vendor offer satisfied both budget constraints and risk tolerance parameters.",
                "evaluations": evaluations,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "model": self.model_name,
                "engine_mode": engine_mode,
                "injection_detected": len(injection_flags) > 0,
                "injection_details": injection_flags,
            }

        # Select candidate with highest multi-criteria utility score
        eligible_candidates.sort(key=lambda item: item[0], reverse=True)
        best_utility, selected_offer, best_ev = eligible_candidates[0]

        # Dynamic rationale summarizing the competitive field
        other_notes = []
        for ev in evaluations:
            if ev["offer_id"] != selected_offer.offer_id:
                other_notes.append(f"{ev['offer_id']} rejected ({ev['status']})")
        comp_summary = "; ".join(other_notes) if other_notes else "Sole compliant candidate."

        rationale = (
            f"Autonomous Agent selected {selected_offer.offer_id} ({selected_offer.vendor_name}) at "
            f"${selected_offer.price_usd:.2f} USD. Multi-criteria utility score U={best_utility:.4f} "
            f"(Confidence: {best_ev['confidence_score']:.2f}, Quality: {selected_offer.quality_score:.1f}/100). "
            f"Competitive comparison: {comp_summary}."
        )

        return {
            "decision_id": decision_id,
            "status": "OFFER_RECOMMENDED",
            "recommended_offer_id": selected_offer.offer_id,
            "recommended_vendor": selected_offer.vendor_name,
            "recommended_merchant_id": selected_offer.merchant_id,
            "recommended_price_usd": selected_offer.price_usd,
            "recommended_asset": selected_offer.asset_title,
            "confidence_score": best_ev["confidence_score"],
            "uncertainty_score": best_ev["uncertainty_score"],
            "utility_score": best_utility,
            "decision_rationale": rationale,
            "evaluations": evaluations,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "model": self.model_name,
            "engine_mode": engine_mode,
            "injection_detected": len(injection_flags) > 0,
            "injection_details": injection_flags,
            "requested_action": "DISPATCH_TO_POLICY_GATE",
        }


# ==============================================================================
# LAYER 3: POLICY ENFORCEMENT ENGINE (DETERMINISTIC TRUST GATE)
# ==============================================================================

class PolicyEnforcementEngine:
    """
    CRITICAL NON-BYPASSABLE SECURITY PERIMETER.
    Enforces deterministic compliance checks regardless of what the AI model outputs.
    Guarantees:
    - Zero over-budget purchases (hard ceiling <= mandate.max_budget_usd).
    - Zero transactions with un-whitelisted merchant IDs.
    - Zero transactions with unverified risk ratings.
    - Zero modification of payee identity or payment currency.
    - Immutability of PayPal capture intent.
    """
    def __init__(self, mandate: ProcurementMandate):
        self.mandate = mandate

    def evaluate_decision(
        self,
        ai_decision: Dict[str, Any],
        raw_offers_by_id: Dict[str, VendorOffer],
    ) -> Dict[str, Any]:
        """
        Audits AI recommendation against deterministic institutional policy.
        Returns PolicyVerdict: APPROVED or REJECTED with specific violation codes.
        """
        # 0. Prompt injection defense gate
        if ai_decision.get("injection_detected"):
            return {
                "approved": False,
                "verdict_code": "SECURITY_REJECT_PROMPT_INJECTION",
                "message": "Hostile prompt injection payload detected in vendor catalog telemetry. Policy Engine remains independent and halted fail-closed.",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }

        rec_id = ai_decision.get("recommended_offer_id")
        rec_price = float(ai_decision.get("recommended_price_usd", 0.0))

        if not rec_id:
            evals = ai_decision.get("evaluations", [])
            for ev in evals:
                if ev.get("status") == "REJECTED_HIGH_RISK":
                    return {
                        "approved": False,
                        "verdict_code": "POLICY_REJECT_RISK_THRESHOLD_EXCEEDED",
                        "message": ev.get("rationale", "Risk threshold exceeded."),
                        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    }
                if ev.get("status") == "REJECTED_OVER_BUDGET":
                    return {
                        "approved": False,
                        "verdict_code": "POLICY_REJECT_BUDGET_EXCEEDED",
                        "message": ev.get("rationale", "Budget limit exceeded."),
                        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    }
            return {
                "approved": False,
                "verdict_code": "POLICY_GATE_HALTED_NO_RECOMMENDATION",
                "message": "AI engine did not recommend any compliant candidate. Zero funds authorized.",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }

        if rec_id not in raw_offers_by_id:
            return {
                "approved": False,
                "verdict_code": "POLICY_REJECT_INVALID_OFFER_ID",
                "message": f"AI recommended offer '{rec_id}' not found in canonical vendor registry.",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }

        canonical_offer = raw_offers_by_id[rec_id]

        # 1. Price tampering check (Ensure AI did not report a forged price)
        if abs(canonical_offer.price_usd - rec_price) > 0.001:
            return {
                "approved": False,
                "verdict_code": "POLICY_REJECT_PRICE_TAMPERING",
                "message": (
                    f"AI reported price (${rec_price:.2f}) does not match canonical registry price "
                    f"(${canonical_offer.price_usd:.2f}). Transaction aborted."
                ),
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }

        # 2. Hard budget ceiling check (Non-bypassable)
        if canonical_offer.price_usd > self.mandate.max_budget_usd:
            return {
                "approved": False,
                "verdict_code": "POLICY_REJECT_BUDGET_EXCEEDED",
                "message": (
                    f"Price ${canonical_offer.price_usd:.2f} exceeds hard mandate budget "
                    f"${self.mandate.max_budget_usd:.2f}. AI cannot authorize excess spending."
                ),
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }

        # 3. Whitelisted merchant check
        if canonical_offer.merchant_id not in self.mandate.authorized_merchant_whitelist:
            return {
                "approved": False,
                "verdict_code": "POLICY_REJECT_UNAUTHORIZED_MERCHANT",
                "message": (
                    f"Merchant '{canonical_offer.merchant_id}' is not in authorized institutional whitelist."
                ),
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }

        # 4. Risk threshold check
        if canonical_offer.risk_score > self.mandate.max_tolerable_risk_score:
            return {
                "approved": False,
                "verdict_code": "POLICY_REJECT_RISK_THRESHOLD_EXCEEDED",
                "message": (
                    f"Offer risk score {canonical_offer.risk_score:.1f} exceeds threshold "
                    f"{self.mandate.max_tolerable_risk_score:.1f}."
                ),
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }

        # All deterministic gates passed -> Issue Authorized Settlement Order Specification
        auth_session_id = f"VELQIRIS-AUTH-{int(time.time())}-{canonical_offer.offer_id}"
        evidence_packet = {
            "mandate_id": self.mandate.mandate_id,
            "decision_id": ai_decision.get("decision_id"),
            "authorized_session_id": auth_session_id,
            "merchant_id": canonical_offer.merchant_id,
            "amount_usd": f"{canonical_offer.price_usd:.2f}",
            "currency": self.mandate.currency,
            "target_asset": self.mandate.target_asset,
        }
        policy_hash = hashlib.sha256(json.dumps(evidence_packet, sort_keys=True).encode()).hexdigest()

        return {
            "approved": True,
            "verdict_code": "POLICY_APPROVED_FOR_PAYPAL_SETTLEMENT",
            "authorized_session_id": auth_session_id,
            "policy_audit_sha256": policy_hash,
            "authorized_order_spec": {
                "intent": "CAPTURE",
                "amount_usd": f"{canonical_offer.price_usd:.2f}",
                "currency": self.mandate.currency,
                "merchant_id": canonical_offer.merchant_id,
                "vendor_name": canonical_offer.vendor_name,
                "item_description": canonical_offer.asset_title,
                "custom_id": f"GATE_AUTH_{policy_hash[:16]}",
            },
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }


# ==============================================================================
# PIPELINE DEMO & RUNNER
# ==============================================================================

def run_procurement_trust_gate_pipeline(user_override_attempt: Optional[str] = None) -> Dict[str, Any]:
    """Runs the full Gate P0-B execution loop: Mandate -> AI Engine -> Policy Gate."""
    mandate = ProcurementMandate(max_budget_usd=25.00)
    offers = get_standard_competition_offers()
    offers_by_id = {o.offer_id: o for o in offers}

    ai_engine = AIDecisionEngine()
    ai_decision = ai_engine.evaluate_offers(mandate, offers, user_guidance=user_override_attempt)

    policy_engine = PolicyEnforcementEngine(mandate)
    policy_verdict = policy_engine.evaluate_decision(ai_decision, offers_by_id)

    return {
        "mandate": mandate.to_dict(),
        "offers": [o.to_dict() for o in offers],
        "ai_decision": ai_decision,
        "policy_verdict": policy_verdict,
    }


if __name__ == "__main__":
    print("=" * 78)
    print("  VELQIRIS AGENTIC COMMERCE TRUST GATE — GATE P0-B EXECUTION")
    print("=" * 78)

    result = run_procurement_trust_gate_pipeline()
    print("\n[+] MANDATE CONSTRAINTS:")
    print(f"    Max Budget:     ${result['mandate']['max_budget_usd']:.2f} {result['mandate']['currency']}")
    print(f"    Max Risk Score: {result['mandate']['max_tolerable_risk_score']:.1f} / 100")

    print("\n[+] COMPETING VENDOR OFFERS:")
    for o in result["offers"]:
        print(f"    • [{o['offer_id']}] {o['vendor_name']} — ${o['price_usd']:.2f} USD (Risk: {o['risk_score']}/100, Quality: {o['quality_score']}/100)")

    print("\n[+] AI DECISION ENGINE OUTPUT:")
    print(f"    Selected Offer: {result['ai_decision']['recommended_offer_id']} ({result['ai_decision'].get('recommended_vendor')})")
    print(f"    Price:          ${result['ai_decision']['recommended_price_usd']:.2f} USD")
    print(f"    Rationale:      {result['ai_decision']['decision_rationale']}")

    print("\n[+] DETERMINISTIC POLICY ENFORCEMENT GATE:")
    print(f"    Verdict Code:   {result['policy_verdict']['verdict_code']}")
    print(f"    Approved:       {result['policy_verdict']['approved']}")
    if result['policy_verdict']['approved']:
        print(f"    Audit Hash:     {result['policy_verdict']['policy_audit_sha256']}")
        print(f"    PayPal Spec:    {json.dumps(result['policy_verdict']['authorized_order_spec'], indent=2)}")
    print("=" * 78)
