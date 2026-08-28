use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

use super::cart_lines_discounts_generate_run::{
    customer_gates_block, utm_gate_blocks, Configuration, CustomerState,
};

#[shopify_function]
fn cart_delivery_options_discounts_generate_run(
    input: schema::cart_delivery_options_discounts_generate_run::Input,
) -> Result<schema::CartDeliveryOptionsDiscountsGenerateRunResult> {
    let config: &Configuration = match input.discount().metafield() {
        Some(metafield) => metafield.json_value(),
        None => {
            return Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult { operations: vec![] });
        }
    };

    let utm_value: Option<String> = input
        .cart()
        .utm_attribute()
        .as_ref()
        .and_then(|a| a.value().cloned());
    if utm_gate_blocks(&config.required_utm_campaign, utm_value.as_ref()) {
        return Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult { operations: vec![] });
    }

    // Free shipping honours the same purchase-history and per-customer order
    // caps as the cart-line discounts, so a spent campaign stops paying for
    // shipping too.
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
        return Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult { operations: vec![] });
    }

    let has_shipping_class = input
        .discount()
        .discount_classes()
        .contains(&schema::DiscountClass::Shipping);

    if !has_shipping_class || !config.free_shipping.unwrap_or(false) {
        return Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult { operations: vec![] });
    }

    let targets: Vec<schema::DeliveryDiscountCandidateTarget> = input
        .cart()
        .delivery_groups()
        .iter()
        .flat_map(|group| {
            group.delivery_options().iter().map(|option| {
                schema::DeliveryDiscountCandidateTarget::DeliveryOption(
                    schema::DeliveryOptionTarget {
                        handle: option.handle().clone(),
                    },
                )
            })
        })
        .collect();

    if targets.is_empty() {
        return Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult { operations: vec![] });
    }

    Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult {
        operations: vec![schema::DeliveryOperation::DeliveryDiscountsAdd(
            schema::DeliveryDiscountsAddOperation {
                candidates: vec![schema::DeliveryDiscountCandidate {
                    targets,
                    value: schema::DeliveryDiscountCandidateValue::Percentage(schema::Percentage {
                        value: Decimal(100.0),
                    }),
                    message: Some("FREE SHIPPING".to_string()),
                    associated_discount_code: None,
                }],
                selection_strategy: schema::DeliveryDiscountSelectionStrategy::All,
            },
        )],
    })
}
