/**
 * Product card / inline display state.
 *
 * Two independent axes, both rendered as data attributes on the card, inline
 * or product-detail root. The components only choose which value to emit —
 * every colour is resolved in CSS (common/components/Product/product.module.css)
 * from the --product-* custom properties that client/entry-server.jsx injects
 * from Admin -> Settings (settings.theme.*).
 *
 *   data-action  cart axis    -> border only
 *   data-price   sale axis    -> border, button, price, strikethrough, badge
 *
 * The button colour deliberately does NOT follow the cart axis: a product in
 * the cart keeps the same button colour it has when not in the cart, and only
 * a sale changes it. The axes are therefore a clean 2x2:
 *
 *                    regular price   sale
 *   not in cart      #d8e7e2         #ffe3d1
 *   in cart          #83aa9d         #f5bfa0
 */
export function getProductState({ amount, sale } = {}) {
    const inCart = Number(amount) > 0
    const onSale = !!sale

    return {
        inCart,
        onSale,
        action: inCart ? 'inCart' : 'regular',
        price: onSale ? 'sale' : 'regular',
    }
}