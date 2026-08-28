use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

// ---------------------------------------------------------------------------
// Configuration — discount metafield `$app:function-configuration`
// Written by the Combined Discount admin app (app/routes/app.combined-discount.jsx).
// ---------------------------------------------------------------------------

/// Legacy single-rate "amount off products" block. Still honoured so discounts
/// created before per-variant rules existed keep working untouched.
#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct ProductAmountOff {
    pub value: f64,
    pub is_percentage: Option<bool>,
    pub eligible_product_ids: Option<Vec<String>>,
    pub eligible_variant_ids: Option<Vec<String>>,
}

/// One tier of the per-variant pricing table. Rules are evaluated in order and
/// every cart line is claimed by at most one rule, so amounts never stack.
#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct ProductAmountOffRule {
    pub value: f64,
    pub is_percentage: Option<bool>,
    pub applies_to_each_item: Option<bool>,
    pub product_ids: Option<Vec<String>>,
    pub variant_ids: Option<Vec<String>>,
    pub message: Option<String>,
}

#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct BuyXGetY {
    pub buy_quantity: i32,
    pub get_quantity: Option<i32>,
    pub discount_percentage: f64,
    pub buy_product_ids: Option<Vec<String>>,
    pub buy_variant_ids: Option<Vec<String>>,
    pub get_product_ids: Option<Vec<String>>,
    pub get_variant_ids: Option<Vec<String>>,
}

#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct OrderAmountOff {
    pub value: f64,
    pub is_percentage: Option<bool>,
}

/// "Only for customers who already purchased before <date>".
///
/// Functions are pure — they cannot read the clock or query order history — so
/// the app projects the customer's purchase history into a customer metafield
/// and this gate does a pure string comparison against it.
#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct CustomerEligibility {
    /// Exclusive upper bound, ISO `YYYY-MM-DD`. The qualifying purchase must be
    /// strictly before this day.
    pub purchased_before: Option<String>,
    /// When true the qualifying purchase must have contained one of the
    /// campaign's qualifying products; when false any purchase counts.
    pub require_qualifying_products: Option<bool>,
}

/// "Works for N separate orders only" — N is merchant-configurable.
#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct UsageLimit {
    pub max_orders_per_customer: Option<i32>,
}

#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct Configuration {
    /// Stable per-discount key. Namespaces this campaign's counters inside the
    /// shared customer state metafield.
    pub campaign_key: Option<String>,
    pub product_amount_off: Option<ProductAmountOff>,
    pub product_amount_off_rules: Option<Vec<ProductAmountOffRule>>,
    pub buy_x_get_y: Option<BuyXGetY>,
    pub order_amount_off: Option<OrderAmountOff>,
    pub free_shipping: Option<bool>,
    pub required_utm_campaign: Option<String>,
    pub customer_eligibility: Option<CustomerEligibility>,
    pub usage_limit: Option<UsageLimit>,
}

// ---------------------------------------------------------------------------
// Customer state — customer metafield `$app:combined-discount-state`
// Read model maintained by the orders/create webhook + backfill job.
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct CampaignState {
    pub key: String,
    /// Date of the earliest order containing one of this campaign's qualifying
    /// products, ISO `YYYY-MM-DD`.
    pub qualified_at: Option<String>,
    /// Distinct orders on which this campaign has already been redeemed.
    pub uses: Option<i32>,
}

#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct CustomerState {
    /// Date of the customer's earliest order, ISO `YYYY-MM-DD`.
    pub first_purchase_at: Option<String>,
    pub campaigns: Option<Vec<CampaignState>>,
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

pub fn utm_gate_blocks(required: &Option<String>, actual: Option<&String>) -> bool {
    match required {
        Some(req) if !req.is_empty() => actual.map(|v| v.as_str()) != Some(req.as_str()),
        _ => false,
    }
}

/// Truncates an ISO timestamp to its `YYYY-MM-DD` day so `"2024-03-11"` and
/// `"2024-03-11T09:12:00Z"` compare identically. Falls back to the whole string
/// rather than panicking if the value is shorter or not on a char boundary.
pub fn day(value: &str) -> &str {
    value.get(..10).unwrap_or(value)
}

fn find_campaign<'a>(
    state: Option<&'a CustomerState>,
    campaign_key: &Option<String>,
) -> Option<&'a CampaignState> {
    let key = campaign_key.as_ref()?;
    state?
        .campaigns
        .as_ref()?
        .iter()
        .find(|entry| &entry.key == key)
}

/// Returns true when the purchase-history gate or the per-customer order cap
/// says this cart must not receive the discount.
///
/// Both gates require an identified customer: an anonymous cart cannot be
/// attributed to a purchase history or to a redemption counter, so it is
/// blocked rather than silently allowed.
pub fn customer_gates_block(
    config: &Configuration,
    has_customer: bool,
    state: Option<&CustomerState>,
) -> bool {
    let cutoff = config
        .customer_eligibility
        .as_ref()
        .and_then(|e| e.purchased_before.as_ref())
        .filter(|d| !d.is_empty());
    let max_orders = config
        .usage_limit
        .as_ref()
        .and_then(|u| u.max_orders_per_customer)
        .filter(|m| *m > 0);

    if cutoff.is_none() && max_orders.is_none() {
        return false;
    }
    if !has_customer {
        return true;
    }

    let campaign = find_campaign(state, &config.campaign_key);

    if let Some(cutoff) = cutoff {
        let require_qualifying = config
            .customer_eligibility
            .as_ref()
            .and_then(|e| e.require_qualifying_products)
            .unwrap_or(false);
        let reference = if require_qualifying {
            campaign.and_then(|c| c.qualified_at.as_ref())
        } else {
            state.and_then(|s| s.first_purchase_at.as_ref())
        };
        match reference {
            Some(purchased_at) if day(purchased_at) < day(cutoff) => {}
            _ => return true,
        }
    }

    if let Some(max) = max_orders {
        if campaign.and_then(|c| c.uses).unwrap_or(0) >= max {
            return true;
        }
    }

    false
}

// ---------------------------------------------------------------------------
// Per-variant pricing table
// ---------------------------------------------------------------------------

/// A rule flattened out of either `productAmountOffRules` or the legacy
/// `productAmountOff` block, so both feed one code path.
pub struct EffectiveRule<'a> {
    pub value: f64,
    pub is_percentage: bool,
    pub applies_to_each_item: bool,
    pub product_ids: Option<&'a Vec<String>>,
    pub variant_ids: Option<&'a Vec<String>>,
    pub message: Option<&'a String>,
}

fn ids_are_empty(ids: Option<&Vec<String>>) -> bool {
    ids.map(|v| v.is_empty()).unwrap_or(true)
}

fn contains_id(ids: Option<&Vec<String>>, needle: &str) -> bool {
    ids.map(|v| v.iter().any(|id| id == needle))
        .unwrap_or(false)
}

/// Claims each `(variant_id, product_id)` for at most one rule.
///
/// Specificity beats order: a rule naming the exact variant wins over one
/// naming the product, which wins over a catch-all rule. Within a tier the
/// first matching rule wins, so merchants control ties by reordering the table.
pub fn assign_rules(rules: &[EffectiveRule], items: &[(String, String)]) -> Vec<Option<usize>> {
    items
        .iter()
        .map(|(variant_id, product_id)| {
            if let Some(idx) = rules
                .iter()
                .position(|r| contains_id(r.variant_ids, variant_id))
            {
                return Some(idx);
            }
            if let Some(idx) = rules
                .iter()
                .position(|r| contains_id(r.product_ids, product_id))
            {
                return Some(idx);
            }
            rules
                .iter()
                .position(|r| ids_are_empty(r.variant_ids) && ids_are_empty(r.product_ids))
        })
        .collect()
}

fn build_effective_rules(config: &Configuration) -> Vec<EffectiveRule<'_>> {
    let mut rules: Vec<EffectiveRule> = config
        .product_amount_off_rules
        .as_ref()
        .map(|list| {
            list.iter()
                .filter(|r| r.value > 0.0)
                .map(|r| EffectiveRule {
                    value: r.value,
                    is_percentage: r.is_percentage.unwrap_or(false),
                    applies_to_each_item: r.applies_to_each_item.unwrap_or(true),
                    product_ids: r.product_ids.as_ref(),
                    variant_ids: r.variant_ids.as_ref(),
                    message: r.message.as_ref(),
                })
                .collect()
        })
        .unwrap_or_default();

    // Legacy block runs last so explicit per-variant rules always win.
    if let Some(legacy) = &config.product_amount_off {
        if legacy.value > 0.0 {
            rules.push(EffectiveRule {
                value: legacy.value,
                is_percentage: legacy.is_percentage.unwrap_or(false),
                applies_to_each_item: true,
                product_ids: legacy.eligible_product_ids.as_ref(),
                variant_ids: legacy.eligible_variant_ids.as_ref(),
                message: None,
            });
        }
    }

    rules
}

fn rule_message(rule: &EffectiveRule) -> String {
    match rule.message {
        Some(custom) if !custom.is_empty() => custom.clone(),
        _ => {
            if rule.is_percentage {
                format!("{}% OFF", rule.value)
            } else {
                format!("{} OFF", rule.value)
            }
        }
    }
}

fn line_matches_eligibility(
    variant_id: &str,
    product_id: &str,
    eligible_variants: Option<&Vec<String>>,
    eligible_products: Option<&Vec<String>>,
) -> bool {
    if ids_are_empty(eligible_variants) && ids_are_empty(eligible_products) {
        return true;
    }
    contains_id(eligible_variants, variant_id) || contains_id(eligible_products, product_id)
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

#[shopify_function]
fn cart_lines_discounts_generate_run(
    input: schema::cart_lines_discounts_generate_run::Input,
) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    let empty = || schema::CartLinesDiscountsGenerateRunResult { operations: vec![] };

    let config: &Configuration = match input.discount().metafield() {
        Some(metafield) => metafield.json_value(),
        None => return Ok(empty()),
    };

    let utm_value: Option<String> = input
        .cart()
        .utm_attribute()
        .as_ref()
        .and_then(|a| a.value().cloned());
    if utm_gate_blocks(&config.required_utm_campaign, utm_value.as_ref()) {
        return Ok(empty());
    }

    // Bound to locals: these accessors hand back owned `Option` views, so the
    // borrows below must outlive the expression that produced them.
    let customer = input
        .cart()
        .buyer_identity()
        .as_ref()
        .map(|identity| identity.customer());
    let customer = customer.as_ref().and_then(|c| c.as_ref());
    let state_metafield = customer.map(|c| c.state());
    let customer_state: Option<&CustomerState> = state_metafield
        .as_ref()
        .and_then(|m| m.as_ref())
        .map(|metafield| metafield.json_value());
    if customer_gates_block(config, customer.is_some(), customer_state) {
        return Ok(empty());
    }

    let has_order_class = input
        .discount()
        .discount_classes()
        .contains(&schema::DiscountClass::Order);
    let has_product_class = input
        .discount()
        .discount_classes()
        .contains(&schema::DiscountClass::Product);

    let lines = input.cart().lines();
    if lines.is_empty() {
        return Ok(empty());
    }

    let mut operations = vec![];
    let mut product_candidates: Vec<schema::ProductDiscountCandidate> = vec![];

    // Amount off order
    if has_order_class {
        if let Some(order) = &config.order_amount_off {
            if order.value > 0.0 {
                let is_pct = order.is_percentage.unwrap_or(false);
                let value = if is_pct {
                    schema::OrderDiscountCandidateValue::Percentage(schema::Percentage {
                        value: Decimal(order.value),
                    })
                } else {
                    schema::OrderDiscountCandidateValue::FixedAmount(schema::FixedAmount {
                        amount: Decimal(order.value),
                    })
                };
                let msg = if is_pct {
                    format!("{}% OFF ORDER", order.value)
                } else {
                    format!("{} OFF ORDER", order.value)
                };
                operations.push(schema::CartOperation::OrderDiscountsAdd(
                    schema::OrderDiscountsAddOperation {
                        selection_strategy: schema::OrderDiscountSelectionStrategy::First,
                        candidates: vec![schema::OrderDiscountCandidate {
                            targets: vec![schema::OrderDiscountCandidateTarget::OrderSubtotal(
                                schema::OrderSubtotalTarget {
                                    excluded_cart_line_ids: vec![],
                                },
                            )],
                            message: Some(msg),
                            value,
                            conditions: None,
                            associated_discount_code: None,
                        }],
                    },
                ));
            }
        }
    }

    // Amount off products — one candidate per pricing rule, disjoint targets.
    if has_product_class {
        let rules = build_effective_rules(config);
        if !rules.is_empty() {
            let mut line_ids: Vec<&String> = vec![];
            let mut items: Vec<(String, String)> = vec![];
            for line in lines.iter() {
                if let schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise::ProductVariant(variant) = line.merchandise() {
                    line_ids.push(line.id());
                    items.push((variant.id().clone(), variant.product().id().clone()));
                }
            }

            let assignments = assign_rules(&rules, &items);
            for (rule_index, rule) in rules.iter().enumerate() {
                let targets: Vec<schema::ProductDiscountCandidateTarget> = assignments
                    .iter()
                    .enumerate()
                    .filter(|(_, assigned)| **assigned == Some(rule_index))
                    .map(|(item_index, _)| {
                        schema::ProductDiscountCandidateTarget::CartLine(schema::CartLineTarget {
                            id: line_ids[item_index].clone(),
                            quantity: None,
                        })
                    })
                    .collect();
                if targets.is_empty() {
                    continue;
                }
                let value = if rule.is_percentage {
                    schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
                        value: Decimal(rule.value),
                    })
                } else {
                    schema::ProductDiscountCandidateValue::FixedAmount(
                        schema::ProductDiscountCandidateFixedAmount {
                            amount: Decimal(rule.value),
                            applies_to_each_item: Some(rule.applies_to_each_item),
                        },
                    )
                };
                product_candidates.push(schema::ProductDiscountCandidate {
                    targets,
                    message: Some(rule_message(rule)),
                    value,
                    associated_discount_code: None,
                });
            }
        }
    }

    // BXGY — trigger set, then discount every eligible reward line (optional cap)
    if has_product_class {
        if let Some(bxgy) = &config.buy_x_get_y {
            if bxgy.buy_quantity > 0 && bxgy.discount_percentage > 0.0 {
                let buy_variants = bxgy.buy_variant_ids.as_ref();
                let buy_products = bxgy.buy_product_ids.as_ref();
                let get_variants = bxgy.get_variant_ids.as_ref();
                let get_products = bxgy.get_product_ids.as_ref();

                let buy_qty: i32 = lines
                    .iter()
                    .filter_map(|line| match line.merchandise() {
                        schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise::ProductVariant(v) => {
                            if line_matches_eligibility(
                                v.id(),
                                v.product().id(),
                                buy_variants,
                                buy_products,
                            ) {
                                Some(*line.quantity())
                            } else {
                                None
                            }
                        }
                        _ => None,
                    })
                    .sum();

                if buy_qty >= bxgy.buy_quantity {
                    let get_lines: Vec<&_> = lines
                        .iter()
                        .filter(|line| match line.merchandise() {
                            schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise::ProductVariant(v) => {
                                line_matches_eligibility(
                                    v.id(),
                                    v.product().id(),
                                    get_variants,
                                    get_products,
                                )
                            }
                            _ => false,
                        })
                        .collect();

                    let targets: Vec<schema::ProductDiscountCandidateTarget> = match bxgy
                        .get_quantity
                    {
                        Some(cap) if cap > 0 => {
                            let mut sorted = get_lines.clone();
                            sorted.sort_by(|a, b| {
                                a.cost()
                                    .amount_per_quantity()
                                    .amount()
                                    .as_f64()
                                    .partial_cmp(&b.cost().amount_per_quantity().amount().as_f64())
                                    .unwrap_or(std::cmp::Ordering::Equal)
                            });
                            let mut remaining = cap;
                            let mut out: Vec<schema::ProductDiscountCandidateTarget> = vec![];
                            for line in sorted.iter() {
                                if remaining <= 0 {
                                    break;
                                }
                                let available = *line.quantity();
                                let take = std::cmp::min(available, remaining);
                                out.push(schema::ProductDiscountCandidateTarget::CartLine(
                                    schema::CartLineTarget {
                                        id: line.id().clone(),
                                        quantity: Some(take),
                                    },
                                ));
                                remaining -= take;
                            }
                            out
                        }
                        _ => get_lines
                            .iter()
                            .map(|line| {
                                schema::ProductDiscountCandidateTarget::CartLine(
                                    schema::CartLineTarget {
                                        id: line.id().clone(),
                                        quantity: None,
                                    },
                                )
                            })
                            .collect(),
                    };

                    if !targets.is_empty() {
                        let qty_label = bxgy
                            .get_quantity
                            .filter(|q| *q > 0)
                            .map(|q| q.to_string())
                            .unwrap_or_else(|| "ALL".to_string());
                        product_candidates.push(schema::ProductDiscountCandidate {
                            targets,
                            message: Some(format!(
                                "BUY {} GET {} AT {}% OFF",
                                bxgy.buy_quantity, qty_label, bxgy.discount_percentage
                            )),
                            value: schema::ProductDiscountCandidateValue::Percentage(
                                schema::Percentage {
                                    value: Decimal(bxgy.discount_percentage),
                                },
                            ),
                            associated_discount_code: None,
                        });
                    }
                }
            }
        }
    }

    if !product_candidates.is_empty() {
        operations.push(schema::CartOperation::ProductDiscountsAdd(
            schema::ProductDiscountsAddOperation {
                selection_strategy: schema::ProductDiscountSelectionStrategy::All,
                candidates: product_candidates,
            },
        ));
    }

    Ok(schema::CartLinesDiscountsGenerateRunResult { operations })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(
        purchased_before: Option<&str>,
        require_qualifying: bool,
        max_orders: Option<i32>,
    ) -> Configuration {
        Configuration {
            campaign_key: Some("cd_test".to_string()),
            customer_eligibility: purchased_before.map(|d| CustomerEligibility {
                purchased_before: Some(d.to_string()),
                require_qualifying_products: Some(require_qualifying),
            }),
            usage_limit: max_orders.map(|m| UsageLimit {
                max_orders_per_customer: Some(m),
            }),
            ..Default::default()
        }
    }

    fn state(first: Option<&str>, qualified: Option<&str>, uses: Option<i32>) -> CustomerState {
        CustomerState {
            first_purchase_at: first.map(String::from),
            campaigns: Some(vec![CampaignState {
                key: "cd_test".to_string(),
                qualified_at: qualified.map(String::from),
                uses,
            }]),
        }
    }

    #[test]
    fn no_gates_allows_anonymous_cart() {
        assert!(!customer_gates_block(&cfg(None, false, None), false, None));
    }

    #[test]
    fn gates_block_anonymous_cart() {
        assert!(customer_gates_block(&cfg(Some("2025-01-01"), false, None), false, None));
        assert!(customer_gates_block(&cfg(None, false, Some(3)), false, None));
    }

    #[test]
    fn purchase_before_cutoff_is_allowed_and_on_or_after_is_blocked() {
        let config = cfg(Some("2025-01-01"), false, None);
        let before = state(Some("2024-12-31"), None, None);
        let on_cutoff = state(Some("2025-01-01"), None, None);
        let after = state(Some("2025-06-02"), None, None);
        assert!(!customer_gates_block(&config, true, Some(&before)));
        assert!(customer_gates_block(&config, true, Some(&on_cutoff)));
        assert!(customer_gates_block(&config, true, Some(&after)));
    }

    #[test]
    fn timestamps_compare_by_day() {
        let config = cfg(Some("2025-01-01"), false, None);
        let before = state(Some("2024-12-31T23:59:00Z"), None, None);
        assert!(!customer_gates_block(&config, true, Some(&before)));
    }

    #[test]
    fn customer_with_no_recorded_purchase_is_blocked() {
        let config = cfg(Some("2025-01-01"), false, None);
        assert!(customer_gates_block(&config, true, None));
        assert!(customer_gates_block(&config, true, Some(&state(None, None, None))));
    }

    #[test]
    fn qualifying_product_mode_ignores_unrelated_first_purchase() {
        let config = cfg(Some("2025-01-01"), true, None);
        // Bought early, but never bought a qualifying product.
        assert!(customer_gates_block(&config, true, Some(&state(Some("2020-01-01"), None, None))));
        // Bought a qualifying product in time.
        assert!(!customer_gates_block(
            &config,
            true,
            Some(&state(Some("2020-01-01"), Some("2024-05-02"), None))
        ));
    }

    #[test]
    fn usage_cap_blocks_on_the_nth_redemption() {
        let config = cfg(None, false, Some(3));
        assert!(!customer_gates_block(&config, true, Some(&state(None, None, Some(0)))));
        assert!(!customer_gates_block(&config, true, Some(&state(None, None, Some(2)))));
        assert!(customer_gates_block(&config, true, Some(&state(None, None, Some(3)))));
        assert!(customer_gates_block(&config, true, Some(&state(None, None, Some(9)))));
    }

    #[test]
    fn usage_counters_are_scoped_per_campaign() {
        let config = cfg(None, false, Some(1));
        let other = CustomerState {
            first_purchase_at: None,
            campaigns: Some(vec![CampaignState {
                key: "cd_other".to_string(),
                qualified_at: None,
                uses: Some(5),
            }]),
        };
        assert!(!customer_gates_block(&config, true, Some(&other)));
    }

    fn rule<'a>(
        value: f64,
        variants: Option<&'a Vec<String>>,
        products: Option<&'a Vec<String>>,
    ) -> EffectiveRule<'a> {
        EffectiveRule {
            value,
            is_percentage: false,
            applies_to_each_item: true,
            product_ids: products,
            variant_ids: variants,
            message: None,
        }
    }

    #[test]
    fn variant_rule_wins_over_product_rule_and_catch_all() {
        let variants = vec!["gid://shopify/ProductVariant/2".to_string()];
        let products = vec!["gid://shopify/Product/1".to_string()];
        let rules = vec![
            rule(1000.0, None, Some(&products)), // product tier, listed first
            rule(9999.0, None, None),            // catch-all
            rule(5000.0, Some(&variants), None), // variant tier, listed last
        ];
        let items = vec![
            (
                "gid://shopify/ProductVariant/2".to_string(),
                "gid://shopify/Product/1".to_string(),
            ),
            (
                "gid://shopify/ProductVariant/3".to_string(),
                "gid://shopify/Product/1".to_string(),
            ),
            (
                "gid://shopify/ProductVariant/4".to_string(),
                "gid://shopify/Product/7".to_string(),
            ),
        ];
        // variant match -> rule 2; product match -> rule 0; neither -> catch-all rule 1.
        assert_eq!(assign_rules(&rules, &items), vec![Some(2), Some(0), Some(1)]);
    }

    #[test]
    fn lines_are_unassigned_when_no_rule_matches() {
        let products = vec!["gid://shopify/Product/1".to_string()];
        let rules = vec![rule(1000.0, None, Some(&products))];
        let items = vec![(
            "gid://shopify/ProductVariant/9".to_string(),
            "gid://shopify/Product/9".to_string(),
        )];
        assert_eq!(assign_rules(&rules, &items), vec![None]);
    }

    #[test]
    fn first_rule_wins_within_a_tier() {
        let a = vec!["gid://shopify/Product/1".to_string()];
        let b = vec!["gid://shopify/Product/1".to_string()];
        let rules = vec![rule(100.0, None, Some(&a)), rule(200.0, None, Some(&b))];
        let items = vec![(
            "gid://shopify/ProductVariant/1".to_string(),
            "gid://shopify/Product/1".to_string(),
        )];
        assert_eq!(assign_rules(&rules, &items), vec![Some(0)]);
    }

    /// Mirrors the live TREELOGYPRICEPRIOR campaign so its exact gate values
    /// stay covered: cutoff 2026-09-01, projected qualifiedAt 2026-08-31 (the
    /// segment backfill's day-before sentinel), cap of 3 orders.
    #[test]
    fn live_treelogy_priority_price_campaign() {
        let config = Configuration {
            campaign_key: Some("cd_treelogypriceprior".to_string()),
            customer_eligibility: Some(CustomerEligibility {
                purchased_before: Some("2026-09-01".to_string()),
                require_qualifying_products: Some(true),
            }),
            usage_limit: Some(UsageLimit {
                max_orders_per_customer: Some(3),
            }),
            ..Default::default()
        };
        let backfilled = |uses| CustomerState {
            first_purchase_at: None,
            campaigns: Some(vec![CampaignState {
                key: "cd_treelogypriceprior".to_string(),
                qualified_at: Some("2026-08-31".to_string()),
                uses,
            }]),
        };

        // Backfilled customer, unused through the third order.
        assert!(!customer_gates_block(&config, true, Some(&backfilled(None))));
        assert!(!customer_gates_block(&config, true, Some(&backfilled(Some(2)))));
        // Fourth order is refused.
        assert!(customer_gates_block(&config, true, Some(&backfilled(Some(3)))));
        // Never purchased before the cutoff -> no projection -> refused.
        assert!(customer_gates_block(&config, true, None));
        // Guest checkout -> refused.
        assert!(customer_gates_block(&config, false, None));
        // First order landed after the cutoff.
        let late = CustomerState {
            first_purchase_at: Some("2026-09-15".to_string()),
            campaigns: Some(vec![CampaignState {
                key: "cd_treelogypriceprior".to_string(),
                qualified_at: Some("2026-09-15".to_string()),
                uses: None,
            }]),
        };
        assert!(customer_gates_block(&config, true, Some(&late)));
    }

    #[test]
    fn utm_gate_still_behaves() {
        assert!(!utm_gate_blocks(&None, None));
        assert!(!utm_gate_blocks(&Some(String::new()), None));
        assert!(utm_gate_blocks(&Some("spring".to_string()), None));
        assert!(!utm_gate_blocks(
            &Some("spring".to_string()),
            Some(&"spring".to_string())
        ));
    }
}
