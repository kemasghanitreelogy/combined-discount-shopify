use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct ProductAmountOff {
    pub value: f64,
    pub is_percentage: Option<bool>,
    pub eligible_product_ids: Option<Vec<String>>,
    pub eligible_variant_ids: Option<Vec<String>>,
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

#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct Configuration {
    pub product_amount_off: Option<ProductAmountOff>,
    pub buy_x_get_y: Option<BuyXGetY>,
    pub order_amount_off: Option<OrderAmountOff>,
    pub free_shipping: Option<bool>,
    pub required_utm_campaign: Option<String>,
}

pub fn utm_gate_blocks(required: &Option<String>, actual: Option<&String>) -> bool {
    match required {
        Some(req) if !req.is_empty() => actual.map(|v| v.as_str()) != Some(req.as_str()),
        _ => false,
    }
}

fn line_matches_eligibility(
    variant_id: &str,
    product_id: &str,
    eligible_variants: Option<&Vec<String>>,
    eligible_products: Option<&Vec<String>>,
) -> bool {
    let v_empty = eligible_variants.map(|v| v.is_empty()).unwrap_or(true);
    let p_empty = eligible_products.map(|p| p.is_empty()).unwrap_or(true);
    if v_empty && p_empty {
        return true;
    }
    if let Some(v) = eligible_variants {
        if v.iter().any(|id| id == variant_id) {
            return true;
        }
    }
    if let Some(p) = eligible_products {
        if p.iter().any(|id| id == product_id) {
            return true;
        }
    }
    false
}

#[shopify_function]
fn cart_lines_discounts_generate_run(
    input: schema::cart_lines_discounts_generate_run::Input,
) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    let config: &Configuration = match input.discount().metafield() {
        Some(metafield) => metafield.json_value(),
        None => {
            return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] });
        }
    };

    let utm_value: Option<String> = input
        .cart()
        .utm_attribute()
        .as_ref()
        .and_then(|a| a.value().cloned());
    if utm_gate_blocks(&config.required_utm_campaign, utm_value.as_ref()) {
        return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] });
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
    let mut operations = vec![];

    // Amount off order
    if has_order_class && !lines.is_empty() {
        if let Some(order) = &config.order_amount_off {
            if order.value > 0.0 {
                let value = if order.is_percentage.unwrap_or(false) {
                    schema::OrderDiscountCandidateValue::Percentage(schema::Percentage {
                        value: Decimal(order.value),
                    })
                } else {
                    schema::OrderDiscountCandidateValue::FixedAmount(schema::FixedAmount {
                        amount: Decimal(order.value),
                    })
                };
                let msg = if order.is_percentage.unwrap_or(false) {
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

    // Amount off products
    if has_product_class && !lines.is_empty() {
        if let Some(product) = &config.product_amount_off {
            if product.value > 0.0 {
                let eligible_variants = product.eligible_variant_ids.as_ref();
                let eligible_products = product.eligible_product_ids.as_ref();
                let targets: Vec<schema::ProductDiscountCandidateTarget> = lines
                    .iter()
                    .filter_map(|line| {
                        let variant = match line.merchandise() {
                            schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise::ProductVariant(v) => v,
                            _ => return None,
                        };
                        if !line_matches_eligibility(
                            variant.id(),
                            variant.product().id(),
                            eligible_variants,
                            eligible_products,
                        ) {
                            return None;
                        }
                        Some(schema::ProductDiscountCandidateTarget::CartLine(
                            schema::CartLineTarget {
                                id: line.id().clone(),
                                quantity: None,
                            },
                        ))
                    })
                    .collect();
                if !targets.is_empty() {
                    let value = if product.is_percentage.unwrap_or(false) {
                        schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
                            value: Decimal(product.value),
                        })
                    } else {
                        schema::ProductDiscountCandidateValue::FixedAmount(
                            schema::ProductDiscountCandidateFixedAmount {
                                amount: Decimal(product.value),
                                applies_to_each_item: Some(true),
                            },
                        )
                    };
                    let msg = if product.is_percentage.unwrap_or(false) {
                        format!("{}% OFF PRODUCTS", product.value)
                    } else {
                        format!("{} OFF PRODUCTS", product.value)
                    };
                    operations.push(schema::CartOperation::ProductDiscountsAdd(
                        schema::ProductDiscountsAddOperation {
                            selection_strategy: schema::ProductDiscountSelectionStrategy::First,
                            candidates: vec![schema::ProductDiscountCandidate {
                                targets,
                                message: Some(msg),
                                value,
                                associated_discount_code: None,
                            }],
                        },
                    ));
                }
            }
        }
    }

    // BXGY — trigger set, then discount every eligible reward line (optional cap)
    if has_product_class && !lines.is_empty() {
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
                        operations.push(schema::CartOperation::ProductDiscountsAdd(
                            schema::ProductDiscountsAddOperation {
                                selection_strategy:
                                    schema::ProductDiscountSelectionStrategy::First,
                                candidates: vec![schema::ProductDiscountCandidate {
                                    targets,
                                    message: Some(format!(
                                        "BUY {} GET {} AT {}% OFF",
                                        bxgy.buy_quantity,
                                        qty_label,
                                        bxgy.discount_percentage
                                    )),
                                    value: schema::ProductDiscountCandidateValue::Percentage(
                                        schema::Percentage {
                                            value: Decimal(bxgy.discount_percentage),
                                        },
                                    ),
                                    associated_discount_code: None,
                                }],
                            },
                        ));
                    }
                }
            }
        }
    }

    Ok(schema::CartLinesDiscountsGenerateRunResult { operations })
}
