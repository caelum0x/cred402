// Command cred402 is a CLI for the Cred402 protocol API.
//
// Usage:
//
//	cred402 [global flags] <command> [subcommand] [args...]
//
// Global flags:
//
//	-api   API base URL (default http://localhost:4021)
//	-key   API key (Bearer token)
//	-json  emit raw JSON instead of formatted tables
//
// Commands:
//
//	cred402 agents list
//	cred402 agents get <id>
//	cred402 agents register <id> <service_type>
//	cred402 credit pool
//	cred402 credit explain <id>
//	cred402 credit draw <id> <cspr>
//	cred402 credit repay <id> <cspr>
//	cred402 market
//	cred402 economics
//	cred402 realfi verify-operator <operator_id> <jurisdiction>
//	cred402 compliance <id>
//	cred402 demo run
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"text/tabwriter"
	"time"

	"github.com/cred402/go-sdk/cred402"
)

type globalFlags struct {
	api  string
	key  string
	json bool
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	g := globalFlags{api: cred402.DefaultBaseURL}

	// Hand-rolled global flag parsing so flags may precede the subcommand and
	// subcommands can own their positional args without flag-package coupling.
	var rest []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-h" || a == "--help" || a == "help":
			usage()
			return 0
		case a == "-json" || a == "--json":
			g.json = true
		case a == "-api" || a == "--api":
			if i+1 >= len(args) {
				return fail("missing value for -api")
			}
			i++
			g.api = args[i]
		case a == "-key" || a == "--key":
			if i+1 >= len(args) {
				return fail("missing value for -key")
			}
			i++
			g.key = args[i]
		case len(a) > 5 && a[:5] == "-api=":
			g.api = a[5:]
		case len(a) > 5 && a[:5] == "-key=":
			g.key = a[5:]
		default:
			rest = append(rest, a)
		}
	}

	if len(rest) == 0 {
		usage()
		return 2
	}
	if g.key == "" {
		g.key = os.Getenv("CRED402_API_KEY")
	}

	client := cred402.New(g.api, cred402.WithAPIKey(g.key))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := rest[0]
	sub := rest[1:]

	switch cmd {
	case "agents":
		return cmdAgents(ctx, client, g, sub)
	case "credit":
		return cmdCredit(ctx, client, g, sub)
	case "market":
		return cmdMarket(ctx, client, g)
	case "economics":
		return cmdEconomics(ctx, client, g)
	case "realfi":
		return cmdRealfi(ctx, client, g, sub)
	case "compliance":
		return cmdCompliance(ctx, client, g, sub)
	case "demo":
		return cmdDemo(ctx, client, g, sub)
	case "health":
		return cmdHealth(ctx, client, g)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", cmd)
		usage()
		return 2
	}
}

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

func cmdAgents(ctx context.Context, c *cred402.Client, g globalFlags, sub []string) int {
	if len(sub) == 0 {
		return fail("usage: cred402 agents list|get <id>|register <id> <service_type>")
	}
	switch sub[0] {
	case "list":
		agents, err := c.ListAgents(ctx)
		if err != nil {
			return apiFail(err)
		}
		if g.json {
			return emitJSON(agents)
		}
		tw := newTab()
		fmt.Fprintln(tw, "AGENT\tSERVICE\tREPUTATION\tCREDIT\tJOBS\tSTAKE (CSPR)\tACTIVE")
		for _, a := range agents {
			fmt.Fprintf(tw, "%s\t%s\t%.0f\t%.0f\t%d\t%s\t%v\n",
				a.AgentID, a.ServiceType, a.ReputationScore, a.CreditScore,
				a.TotalJobsCompleted, cspr(a.Stake), a.Active)
		}
		return flush(tw)
	case "get":
		if len(sub) < 2 {
			return fail("usage: cred402 agents get <id>")
		}
		a, err := c.GetAgent(ctx, sub[1])
		if err != nil {
			return apiFail(err)
		}
		if g.json {
			return emitJSON(a)
		}
		tw := newTab()
		fmt.Fprintf(tw, "Agent ID\t%s\n", a.AgentID)
		fmt.Fprintf(tw, "Service type\t%s\n", a.ServiceType)
		fmt.Fprintf(tw, "Owner key\t%s\n", a.OwnerPublicKey)
		fmt.Fprintf(tw, "Stake (CSPR)\t%s\n", cspr(a.Stake))
		fmt.Fprintf(tw, "Jobs completed\t%d\n", a.TotalJobsCompleted)
		fmt.Fprintf(tw, "Reputation\t%.0f\n", a.ReputationScore)
		fmt.Fprintf(tw, "Credit score\t%.0f\n", a.CreditScore)
		fmt.Fprintf(tw, "Accuracy\t%.0f\n", a.AccuracyScore)
		fmt.Fprintf(tw, "Dispute rate\t%.2f%%\n", a.DisputeRate*100)
		fmt.Fprintf(tw, "Active\t%v\n", a.Active)
		fmt.Fprintf(tw, "Receipts\t%d\n", len(a.X402RevenueHistory))
		return flush(tw)
	case "register":
		if len(sub) < 3 {
			return fail("usage: cred402 agents register <id> <service_type>")
		}
		p, err := c.RegisterAgent(ctx, cred402.RegisterAgentInput{
			AgentID:     sub[1],
			ServiceType: sub[2],
		}, idemKey())
		if err != nil {
			return apiFail(err)
		}
		if g.json {
			return emitJSON(p)
		}
		fmt.Printf("registered %s (%s)\n", p.AgentID, p.ServiceType)
		printPassport(p)
		return 0
	default:
		return fail("usage: cred402 agents list|get <id>|register <id> <service_type>")
	}
}

func printPassport(p *cred402.Passport) {
	tw := newTab()
	fmt.Fprintf(tw, "Operator\t%s\n", p.Operator)
	fmt.Fprintf(tw, "Credit limit (CSPR)\t%s\n", cspr(p.CreditLimit))
	fmt.Fprintf(tw, "Outstanding (CSPR)\t%s\n", cspr(p.OutstandingDebt))
	fmt.Fprintf(tw, "Reputation\t%.0f\n", p.ReputationScore)
	fmt.Fprintf(tw, "Credit score\t%.0f\n", p.CreditScore)
	fmt.Fprintf(tw, "Risk flags\t%v\n", p.RiskFlags)
	_ = flush(tw)
}

// ---------------------------------------------------------------------------
// credit
// ---------------------------------------------------------------------------

func cmdCredit(ctx context.Context, c *cred402.Client, g globalFlags, sub []string) int {
	if len(sub) == 0 {
		return fail("usage: cred402 credit pool|explain <id>|draw <id> <cspr>|repay <id> <cspr>")
	}
	switch sub[0] {
	case "pool":
		pool, err := c.CreditPool(ctx)
		if err != nil {
			return apiFail(err)
		}
		if g.json {
			return emitJSON(pool)
		}
		tw := newTab()
		fmt.Fprintf(tw, "Total liquidity (CSPR)\t%s\n", cspr(pool.TotalLiquidity))
		fmt.Fprintf(tw, "Outstanding credit (CSPR)\t%s\n", cspr(pool.OutstandingCredit))
		fmt.Fprintf(tw, "Interest accrued (CSPR)\t%s\n", cspr(pool.InterestAccrued))
		fmt.Fprintf(tw, "Defaults\t%d\n", pool.Defaults)
		fmt.Fprintf(tw, "Active lines\t%d\n", len(pool.CreditLines))
		_ = flush(tw)
		if len(pool.CreditLines) > 0 {
			fmt.Println()
			lt := newTab()
			fmt.Fprintln(lt, "AGENT\tMAX (CSPR)\tDRAWN (CSPR)\tRATE (bps)\tHEALTH (bps)\tSTATUS")
			for _, l := range pool.CreditLines {
				fmt.Fprintf(lt, "%s\t%s\t%s\t%d\t%d\t%s\n",
					l.AgentID, cspr(l.MaxCredit), cspr(l.Drawn), l.InterestRateBps, l.HealthFactorBps, l.Status)
			}
			_ = flush(lt)
		}
		return 0
	case "explain":
		if len(sub) < 2 {
			return fail("usage: cred402 credit explain <id>")
		}
		exp, err := c.ExplainCredit(ctx, sub[1])
		if err != nil {
			return apiFail(err)
		}
		if g.json {
			return emitJSON(exp)
		}
		d := exp.Decision
		tw := newTab()
		fmt.Fprintf(tw, "Policy\t%s\n", d.PolicyVersion)
		fmt.Fprintf(tw, "Eligible\t%v\n", exp.Eligible)
		fmt.Fprintf(tw, "Credit line (CSPR)\t%s\n", cspr(d.CreditLine))
		fmt.Fprintf(tw, "Base limit (CSPR)\t%s\n", cspr(d.BaseLimit))
		fmt.Fprintf(tw, "30-day revenue (CSPR)\t%s\n", cspr(d.Last30DayRevenue))
		fmt.Fprintf(tw, "Interest rate (bps)\t%d\n", d.InterestRateBps)
		fmt.Fprintf(tw, "Credit score\t%.0f\n", d.CreditScore)
		fmt.Fprintf(tw, "Stake multiplier\t%.2f\n", d.StakeMultiplier)
		fmt.Fprintf(tw, "Fraud score\t%.0f\n", exp.FraudScore)
		fmt.Fprintf(tw, "RealFi multiplier\t%.2f\n", exp.RealfiMultiplier)
		_ = flush(tw)
		fmt.Println("\nReason codes:")
		rt := newTab()
		fmt.Fprintln(rt, "POLARITY\tCODE\tDETAIL")
		for _, rc := range d.ReasonCodes {
			fmt.Fprintf(rt, "%s\t%s\t%s\n", rc.Polarity, rc.Code, rc.Detail)
		}
		return flush(rt)
	case "draw", "repay":
		if len(sub) < 3 {
			return fail("usage: cred402 credit " + sub[0] + " <id> <cspr>")
		}
		amt, err := strconv.ParseFloat(sub[2], 64)
		if err != nil {
			return fail(fmt.Sprintf("invalid CSPR amount %q: %v", sub[2], err))
		}
		if sub[0] == "draw" {
			line, err := c.DrawCredit(ctx, sub[1], amt, idemKey())
			if err != nil {
				return apiFail(err)
			}
			if g.json {
				return emitJSON(line)
			}
			printLine("drew", amt, line)
			return 0
		}
		res, err := c.RepayCredit(ctx, sub[1], amt, idemKey())
		if err != nil {
			return apiFail(err)
		}
		if g.json {
			return emitJSON(res)
		}
		printLine("repaid", amt, &res.Line)
		fmt.Printf("interest paid: %s CSPR\n", cspr(res.Interest))
		return 0
	default:
		return fail("usage: cred402 credit pool|explain <id>|draw <id> <cspr>|repay <id> <cspr>")
	}
}

func printLine(verb string, amt float64, l *cred402.CreditLine) {
	fmt.Printf("%s %.4f CSPR against %s\n", verb, amt, l.AgentID)
	tw := newTab()
	fmt.Fprintf(tw, "Max credit (CSPR)\t%s\n", cspr(l.MaxCredit))
	fmt.Fprintf(tw, "Drawn (CSPR)\t%s\n", cspr(l.Drawn))
	fmt.Fprintf(tw, "Health (bps)\t%d\n", l.HealthFactorBps)
	fmt.Fprintf(tw, "Status\t%s\n", l.Status)
	_ = flush(tw)
}

// ---------------------------------------------------------------------------
// market / economics / realfi / compliance / demo / health
// ---------------------------------------------------------------------------

func cmdMarket(ctx context.Context, c *cred402.Client, g globalFlags) int {
	listings, err := c.Marketplace(ctx)
	if err != nil {
		return apiFail(err)
	}
	if g.json {
		return emitJSON(listings)
	}
	tw := newTab()
	fmt.Fprintln(tw, "LISTING\tAGENT\tCATEGORY\tSTRATEGY\tPRICE (CSPR)\tMARGIN (bps)\tCHAINS")
	for _, l := range listings {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%d\t%v\n",
			l.ListingID, l.AgentID, l.Category, l.Strategy, cspr(l.BasePrice), l.MarginBps, l.SupportedChains)
	}
	return flush(tw)
}

func cmdEconomics(ctx context.Context, c *cred402.Client, g globalFlags) int {
	e, err := c.Economics(ctx)
	if err != nil {
		return apiFail(err)
	}
	if g.json {
		return emitJSON(e)
	}
	tw := newTab()
	fmt.Fprintln(tw, "FEES")
	fmt.Fprintf(tw, "Facilitator (bps)\t%d\n", e.Fees.FacilitatorFeeBps)
	fmt.Fprintf(tw, "Origination (bps)\t%d\n", e.Fees.OriginationFeeBps)
	fmt.Fprintf(tw, "Interest spread (bps)\t%d\n", e.Fees.InterestSpreadBps)
	fmt.Fprintf(tw, "Late fee (bps)\t%d\n", e.Fees.LateFeeBps)
	fmt.Fprintln(tw, "\nHEALTH")
	fmt.Fprintf(tw, "Utilization\t%.4f\n", e.Health.Utilization)
	fmt.Fprintf(tw, "Realized APY\t%.4f\n", e.Health.RealizedAPY)
	fmt.Fprintf(tw, "Loss rate\t%.4f\n", e.Health.LossRate)
	fmt.Fprintf(tw, "Risk flags\t%v\n", e.Health.RiskFlags)
	return flush(tw)
}

func cmdRealfi(ctx context.Context, c *cred402.Client, g globalFlags, sub []string) int {
	if len(sub) == 0 {
		return fail("usage: cred402 realfi verify-operator <operator_id> <jurisdiction>")
	}
	switch sub[0] {
	case "verify-operator":
		if len(sub) < 3 {
			return fail("usage: cred402 realfi verify-operator <operator_id> <jurisdiction>")
		}
		v, err := c.VerifyOperator(ctx, cred402.VerifyOperatorInput{
			OperatorID:            sub[1],
			Jurisdiction:          sub[2],
			VerificationReference: "cli-" + time.Now().Format("20060102T150405"),
		}, idemKey())
		if err != nil {
			return apiFail(err)
		}
		if g.json {
			return emitJSON(v)
		}
		tw := newTab()
		fmt.Fprintf(tw, "Operator\t%s\n", v.Record.OperatorID)
		fmt.Fprintf(tw, "Provider\t%s\n", v.Record.Provider)
		fmt.Fprintf(tw, "Level\t%s\n", v.Record.VerificationLevel)
		fmt.Fprintf(tw, "Jurisdiction\t%s\n", v.Record.Jurisdiction)
		fmt.Fprintf(tw, "Status\t%s\n", v.Record.Status)
		fmt.Fprintf(tw, "Attestation hash\t%s\n", v.AttestationHash)
		return flush(tw)
	default:
		return fail("usage: cred402 realfi verify-operator <operator_id> <jurisdiction>")
	}
}

func cmdCompliance(ctx context.Context, c *cred402.Client, g globalFlags, sub []string) int {
	if len(sub) < 1 {
		return fail("usage: cred402 compliance <id>")
	}
	r, err := c.ScreenCompliance(ctx, sub[0])
	if err != nil {
		return apiFail(err)
	}
	if g.json {
		return emitJSON(r)
	}
	fmt.Printf("subject: %s  cleared: %v\n\n", r.Screen.Subject, r.Screen.Cleared)
	tw := newTab()
	fmt.Fprintln(tw, "CHECK\tPASSED\tDETAIL")
	for _, ch := range r.Screen.Checks {
		fmt.Fprintf(tw, "%s\t%v\t%s\n", ch.Name, ch.Passed, ch.Detail)
	}
	return flush(tw)
}

func cmdDemo(ctx context.Context, c *cred402.Client, g globalFlags, sub []string) int {
	if len(sub) == 0 || sub[0] != "run" {
		return fail("usage: cred402 demo run")
	}
	res, err := c.RunDemo(ctx)
	if err != nil {
		return apiFail(err)
	}
	if g.json {
		return emitJSON(res)
	}
	for _, scene := range res.Scenes {
		fmt.Printf("\n== %s ==\n", scene.Scene)
		for _, line := range scene.Lines {
			fmt.Printf("  %s\n", line)
		}
	}
	return 0
}

func cmdHealth(ctx context.Context, c *cred402.Client, g globalFlags) int {
	h, err := c.Health(ctx)
	if err != nil {
		return apiFail(err)
	}
	if g.json {
		return emitJSON(h)
	}
	fmt.Printf("ok=%v env=%s policy=%s\n", h.OK, h.Env, h.Policy)
	return 0
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func newTab() *tabwriter.Writer {
	return tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
}

func flush(tw *tabwriter.Writer) int {
	_ = tw.Flush()
	return 0
}

func cspr(m cred402.Motes) string {
	return strconv.FormatFloat(m.CSPR(), 'f', -1, 64)
}

func emitJSON(v any) int {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return fail(err.Error())
	}
	return 0
}

func idemKey() string {
	return "cli-" + strconv.FormatInt(time.Now().UnixNano(), 36)
}

func fail(msg string) int {
	fmt.Fprintln(os.Stderr, "error: "+msg)
	return 1
}

func apiFail(err error) int {
	var apiErr *cred402.APIError
	if e, ok := err.(*cred402.APIError); ok {
		apiErr = e
	}
	if apiErr != nil {
		fmt.Fprintln(os.Stderr, "error: "+apiErr.Error())
		if apiErr.IsNotFound() {
			return 4
		}
		if apiErr.IsValidation() {
			return 3
		}
		return 1
	}
	fmt.Fprintln(os.Stderr, "error: "+err.Error())
	return 1
}

func usage() {
	fmt.Fprint(os.Stderr, `cred402 — CLI for the Cred402 protocol

Usage:
  cred402 [global flags] <command> [args...]

Global flags:
  -api <url>   API base URL (default http://localhost:4021)
  -key <key>   API key (Bearer); falls back to $CRED402_API_KEY
  -json        emit raw JSON instead of formatted tables

Commands:
  agents list                          list registered agents
  agents get <id>                      show one agent
  agents register <id> <service_type>  register a new agent
  credit pool                          show credit pool state
  credit explain <id>                  explain an agent's credit decision
  credit draw <id> <cspr>              draw against a credit line
  credit repay <id> <cspr>             repay a credit line
  market                               list marketplace listings
  economics                            show protocol economics
  realfi verify-operator <op> <jur>    verify a RealFi operator
  compliance <id>                      run a compliance screen
  demo run                             run the end-to-end demo flow
  health                               gateway health check
`)
}
