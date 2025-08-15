import { Component } from '@theme/component';
import { fetchConfig, onAnimationEnd, preloadImage } from '@theme/utilities';
import { ThemeEvents, CartAddEvent, CartErrorEvent, VariantUpdateEvent } from '@theme/events';
import { cartPerformance } from '@theme/performance';
import { morph } from '@theme/morph';

export const ADD_TO_CART_TEXT_ANIMATION_DURATION = 2000;

/**
 * A custom element that manages an add to cart button.
 *
 * @typedef {object} AddToCartRefs
 * @property {HTMLButtonElement} addToCartButton - The add to cart button.
 * @extends Component<AddToCartRefs>
 */
export class AddToCartComponent extends Component {
  requiredRefs = ['addToCartButton'];

  /** @type {number | undefined} */
  #animationTimeout;

  /** @type {number | undefined} */
  #cleanupTimeout;

  connectedCallback() {
    super.connectedCallback();

    this.addEventListener('pointerenter', this.#preloadImage);
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    if (this.#animationTimeout) clearTimeout(this.#animationTimeout);
    if (this.#cleanupTimeout) clearTimeout(this.#cleanupTimeout);
    this.removeEventListener('pointerenter', this.#preloadImage);
  }

  /**
   * Disables the add to cart button.
   */
  disable() {
    this.refs.addToCartButton.disabled = true;
  }

  /**
   * Enables the add to cart button.
   */
  enable() {
    this.refs.addToCartButton.disabled = false;
  }

  /**
   * Handles the click event for the add to cart button.
   * @param {MouseEvent & {target: HTMLElement}} event - The click event.
   */
  handleClick(event) {
    this.animateAddToCart();

    if (!event.target.closest('.quick-add-modal')) this.#animateFlyToCart();
  }

  #preloadImage = () => {
    const image = this.dataset.productVariantMedia;

    if (!image) return;

    preloadImage(image);
  };

  /**
   * Animates the fly to cart animation.
   */
  #animateFlyToCart() {
    const { addToCartButton } = this.refs;
    const cartIcon = document.querySelector('.header-actions__cart-icon');

    const image = this.dataset.productVariantMedia;

    if (!cartIcon || !addToCartButton || !image) return;

    const flyToCartElement = /** @type {FlyToCart} */ (document.createElement('fly-to-cart'));

    flyToCartElement.style.setProperty('background-image', `url(${image})`);
    flyToCartElement.source = addToCartButton;
    flyToCartElement.destination = cartIcon;

    document.body.appendChild(flyToCartElement);
  }

  /**
   * Animates the add to cart button.
   */
  animateAddToCart() {
    const { addToCartButton } = this.refs;

    if (this.#animationTimeout) clearTimeout(this.#animationTimeout);
    if (this.#cleanupTimeout) clearTimeout(this.#cleanupTimeout);

    if (!addToCartButton.classList.contains('atc-added')) {
      addToCartButton.classList.add('atc-added');
    }

    this.#animationTimeout = setTimeout(() => {
      this.#cleanupTimeout = setTimeout(() => {
        this.refs.addToCartButton.classList.remove('atc-added');
      }, 10);
    }, ADD_TO_CART_TEXT_ANIMATION_DURATION);
  }
}

if (!customElements.get('add-to-cart-component')) {
  customElements.define('add-to-cart-component', AddToCartComponent);
}

/**
 * A custom element that manages a product form.
 *
 * @typedef {object} ProductFormRefs
 * @property {HTMLInputElement} variantId - The form input for submitting the variant ID.
 * @property {AddToCartComponent | undefined} addToCartButtonContainer - The add to cart button container element.
 * @property {HTMLElement | undefined} addToCartTextError - The add to cart text error.
 * @property {HTMLElement | undefined} acceleratedCheckoutButtonContainer - The accelerated checkout button container element.
 * @property {HTMLElement} liveRegion - The live region.
 *
 * @extends Component<ProductFormRefs>
 */
class ProductFormComponent extends Component {
  requiredRefs = ['variantId', 'liveRegion'];
  #abortController = new AbortController();

  /** @type {number | undefined} */
  #timeout;

  connectedCallback() {
    super.connectedCallback();

    const { signal } = this.#abortController;
    const target = this.closest('.shopify-section, dialog, product-card');
    target?.addEventListener(ThemeEvents.variantUpdate, this.#onVariantUpdate, { signal });
    target?.addEventListener(ThemeEvents.variantSelected, this.#onVariantSelected, { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    this.#abortController.abort();
  }

  /**
   * Handles the submit event for the product form.
   *
   * @param {Event} event - The submit event.
   */
  handleSubmit(event) {
    const { addToCartTextError } = this.refs;
    // Stop default behaviour from the browser
    event.preventDefault();

    if (this.#timeout) clearTimeout(this.#timeout);

    // Check if the add to cart button is disabled and do an early return if it is
    if (this.refs.addToCartButtonContainer?.refs.addToCartButton?.getAttribute('disabled') === 'true') return;

    // Send the add to cart information to the cart
    const form = this.querySelector('form');

    if (!form) throw new Error('Product form element missing');

    const formData = new FormData(form);

    const cartItemsComponents = document.querySelectorAll('cart-items-component');
    let cartItemComponentsSectionIds = [];
    cartItemsComponents.forEach((item) => {
      if (item instanceof HTMLElement && item.dataset.sectionId) {
        cartItemComponentsSectionIds.push(item.dataset.sectionId);
      }
      formData.append('sections', cartItemComponentsSectionIds.join(','));
    });

    const fetchCfg = fetchConfig('javascript', { body: formData });

    fetch(Theme.routes.cart_add_url, {
      ...fetchCfg,
      headers: {
        ...fetchCfg.headers,
        Accept: 'text/html',
      },
    })
      .then((response) => response.json())
      .then((response) => {
        if (response.status) {
          window.dispatchEvent(new CartErrorEvent(this.id, response.message));

          if (!addToCartTextError) return;
          addToCartTextError.classList.remove('hidden');

          // Reuse the text node if the user is spam-clicking
          const textNode = addToCartTextError.childNodes[2];
          if (textNode) {
            textNode.textContent = response.message;
          } else {
            const newTextNode = document.createTextNode(response.message);
            addToCartTextError.appendChild(newTextNode);
          }

          // Create or get existing error live region for screen readers
          this.#setLiveRegionText(response.message);

          this.#timeout = setTimeout(() => {
            if (!addToCartTextError) return;
            addToCartTextError.classList.add('hidden');

            // Clear the announcement
            this.#clearLiveRegionText();
          }, 10000);

          // When we add more than the maximum amount of items to the cart, we need to dispatch a cart update event
          // because our back-end still adds the max allowed amount to the cart.
          this.dispatchEvent(
            new CartAddEvent({}, this.id, {
              didError: true,
              source: 'product-form-component',
              itemCount: Number(formData.get('quantity')) || Number(this.dataset.quantityDefault),
              productId: this.dataset.productId,
            })
          );

          return;
        } else {
          const id = formData.get('id');

          if (addToCartTextError) {
            addToCartTextError.classList.add('hidden');
            addToCartTextError.removeAttribute('aria-live');
          }

          if (!id) throw new Error('Form ID is required');

          // Add aria-live region to inform screen readers that the item was added
          if (this.refs.addToCartButtonContainer?.refs.addToCartButton) {
            const addToCartButton = this.refs.addToCartButtonContainer.refs.addToCartButton;
            const addedTextElement = addToCartButton.querySelector('.add-to-cart-text--added');
            const addedText = addedTextElement?.textContent?.trim() || Theme.translations.added;

            this.#setLiveRegionText(addedText);

            setTimeout(() => {
              this.#clearLiveRegionText();
            }, 5000);
          }

          this.dispatchEvent(
            new CartAddEvent({}, id.toString(), {
              source: 'product-form-component',
              itemCount: Number(formData.get('quantity')) || Number(this.dataset.quantityDefault),
              productId: this.dataset.productId,
              sections: response.sections,
            })
          );
        }
      })
      .catch((error) => {
        console.error(error);
      })
      .finally(() => {
        // add more thing to do in here if needed.
        cartPerformance.measureFromEvent('add:user-action', event);
      });
  }

  /**
   * @param {*} text
   */
  #setLiveRegionText(text) {
    const liveRegion = this.refs.liveRegion;
    liveRegion.textContent = text;
  }

  #clearLiveRegionText() {
    const liveRegion = this.refs.liveRegion;
    liveRegion.textContent = '';
  }

  /**
   * @param {VariantUpdateEvent} event
   */
  #onVariantUpdate = (event) => {
    if (event.detail.data.newProduct) {
      this.dataset.productId = event.detail.data.newProduct.id;
    } else if (event.detail.data.productId !== this.dataset.productId) {
      return;
    }

    const { variantId, addToCartButtonContainer } = this.refs;

    const currentAddToCartButton = addToCartButtonContainer?.refs.addToCartButton;
    const newAddToCartButton = event.detail.data.html.querySelector('[ref="addToCartButton"]');

    if (!currentAddToCartButton) return;

    // Update the button state
    if (event.detail.resource == null || event.detail.resource.available == false) {
      addToCartButtonContainer.disable();
      this.refs.acceleratedCheckoutButtonContainer?.setAttribute('hidden', 'true');
    } else {
      addToCartButtonContainer.enable();
      this.refs.acceleratedCheckoutButtonContainer?.removeAttribute('hidden');
    }

    // Update the add to cart button text and icon
    if (newAddToCartButton) {
      morph(currentAddToCartButton, newAddToCartButton);
    }

    // Update the variant ID
    variantId.value = event.detail.resource.id ?? '';

    // Set the data attribute for the add to cart button to the product variant media if it exists
    if (event.detail.resource) {
      const productVariantMedia = event.detail.resource.featured_media?.preview_image?.src;
      productVariantMedia &&
        addToCartButtonContainer?.setAttribute('data-product-variant-media', productVariantMedia + '&width=100');
    }
  };

  /**
   * Disable the add to cart button while the UI is updating before #onVariantUpdate is called.
   * Accelerated checkout button is also disabled via its own event listener not exposed to the theme.
   */
  #onVariantSelected = () => {
    this.refs.addToCartButtonContainer?.disable();
  };
}

if (!customElements.get('product-form-component')) {
  customElements.define('product-form-component', ProductFormComponent);
}

class FlyToCart extends HTMLElement {
  /** @type {Element} */
  source;

  /** @type {Element} */
  destination;

  connectedCallback() {
    this.#animate();
  }

  #animate() {
    const rect = this.getBoundingClientRect();
    const sourceRect = this.source.getBoundingClientRect();
    const destinationRect = this.destination.getBoundingClientRect();

    //Define bezier curve points
    // Maybe add half of the size of the flying thingy to the x and y to make it center properly
    const offset = {
      x: rect.width / 2,
      y: rect.height / 2,
    };
    const startPoint = {
      x: sourceRect.left + sourceRect.width / 2 - offset.x,
      y: sourceRect.top + sourceRect.height / 2 - offset.y,
    };

    const endPoint = {
      x: destinationRect.left + destinationRect.width / 2 - offset.x,
      y: destinationRect.top + destinationRect.height / 2 - offset.y,
    };

    //Calculate the control points
    const controlPoint1 = { x: startPoint.x, y: startPoint.y - 200 }; // Go up 200px
    const controlPoint2 = { x: endPoint.x - 300, y: endPoint.y - 100 }; // Go left 300px and up 100px

    //Animation variables
    /** @type {number | null} */
    let startTime = null;
    const duration = 600; // 600ms

    this.style.opacity = '1';

    /**
     * Animates the flying thingy along the bezier curve.
     * @param {number} currentTime - The current time.
     */
    const animate = (currentTime) => {
      if (!startTime) startTime = currentTime;
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Calculate current position along the bezier curve
      const position = bezierPoint(progress, startPoint, controlPoint1, controlPoint2, endPoint);

      //Update the position of the flying thingy
      this.style.setProperty('--x', `${position.x}px`);
      this.style.setProperty('--y', `${position.y}px`);

      // Scale down as it approaches the cart
      const scale = 1 - progress * 0.5;
      this.style.setProperty('--scale', `${scale}`);

      //Continue the animation if not finished
      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        //Fade out the flying thingy
        this.style.opacity = '0';
        onAnimationEnd(this, () => this.remove());
      }
    };

    // Position the flying thingy back to the start point
    this.style.setProperty('--x', `${startPoint.x}px`);
    this.style.setProperty('--y', `${startPoint.y}px`);

    //Start the animation
    requestAnimationFrame(animate);
  }
}

/**
 * Calculates a point on a cubic Bézier curve.
 * @param {number} t - The parameter value (0 <= t <= 1).
 * @param {{x: number, y: number}} p0 - The starting point (x, y).
 * @param {{x: number, y: number}} p1 - The first control point (x, y).
 * @param {{x: number, y: number}} p2 - The second control point (x, y).
 * @param {{x: number, y: number}} p3 - The ending point (x, y).
 * @returns {{x: number, y: number}} The point on the curve.
 */
function bezierPoint(t, p0, p1, p2, p3) {
  const cX = 3 * (p1.x - p0.x);
  const bX = 3 * (p2.x - p1.x) - cX;
  const aX = p3.x - p0.x - cX - bX;

  const cY = 3 * (p1.y - p0.y);
  const bY = 3 * (p2.y - p1.y) - cY;
  const aY = p3.y - p0.y - cY - bY;

  const x = aX * Math.pow(t, 3) + bX * Math.pow(t, 2) + cX * t + p0.x;
  const y = aY * Math.pow(t, 3) + bY * Math.pow(t, 2) + cY * t + p0.y;

  return { x, y };
}

if (!customElements.get('fly-to-cart')) {
  customElements.define('fly-to-cart', FlyToCart);
}


export const PREORDER_ANIMATION_DURATION = 2000;

/**
 * A custom element that manages a pre-order button for separate pre-order products.
 * This component handles dynamic variant matching and cart operations.
 */
class PreorderButtonComponent extends Component {
  /** @type {number | undefined} */
  #animationTimeout;

  /** @type {number | undefined} */
  #cleanupTimeout;

  /** @type {AbortController} */
  #abortController = new AbortController();

  /** @type {Object | null} */
  #preorderProduct = null;

  connectedCallback() {
    super.connectedCallback();
    
    const { signal } = this.#abortController;
    
    const button = this.querySelector('[data-preorder-button]');
    if (button) {
      button.addEventListener('click', this.#handleClick.bind(this), { signal });
    }

    // Listen for variant updates on the main product - use more specific targeting
    const target = this.closest('.shopify-section') || 
                   this.closest('.product-information') || 
                   document;
    
    target?.addEventListener(ThemeEvents.variantUpdate, this.#onVariantUpdate.bind(this), { signal });
    target?.addEventListener(ThemeEvents.variantSelected, this.#onVariantSelected.bind(this), { signal });
    
    // Also listen on document level to catch all variant updates
    document.addEventListener(ThemeEvents.variantUpdate, this.#onVariantUpdate.bind(this), { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    
    if (this.#animationTimeout) clearTimeout(this.#animationTimeout);
    if (this.#cleanupTimeout) clearTimeout(this.#cleanupTimeout);
    
    this.#abortController.abort();
  }

  /**
   * Handle variant selection (disable button during update)
   */
  #onVariantSelected = () => {
    const button = this.querySelector('[data-preorder-button]');
    if (button) {
      button.disabled = true;
    }
  };

  /**
   * Handle variant updates from the main product
   * @param {VariantUpdateEvent} event 
   */
  async #onVariantUpdate(event) {
    // Debug logging
    console.log('Preorder component received variant update:', event.detail);
    
    // Check if this update is for our product
    const eventProductId = event.detail.data.productId;
    const ourProductId = this.dataset.originalProductId;
    
    console.log('Event product ID:', eventProductId, 'Our product ID:', ourProductId);
    
    // Only process if this is for our product
    if (eventProductId !== ourProductId) {
      console.log('Variant update not for our product, ignoring');
      return;
    }

    const selectedVariant = event.detail.resource;
    if (!selectedVariant) {
      console.log('No selected variant in event');
      this.#updateButtonState(null);
      return;
    }

    const newVariantSku = selectedVariant.sku;
    const currentSku = this.dataset.currentVariantSku;

    console.log('New SKU:', newVariantSku, 'Current SKU:', currentSku);

    // If the SKU hasn't changed, just update the button state
    if (newVariantSku === currentSku) {
      console.log('SKU unchanged, updating button state only');
      this.#updateButtonState(selectedVariant);
      return;
    }

    // Update current variant SKU
    this.dataset.currentVariantSku = newVariantSku;

    try {
      // Find matching preorder variant
      console.log('Finding matching preorder variant for SKU:', newVariantSku);
      const matchingVariant = await this.#findMatchingPreorderVariant(newVariantSku);
      
      if (matchingVariant) {
        // Update component data
        this.dataset.variantId = matchingVariant.id;
        this.#updateButtonDisplay(matchingVariant);
        
        console.log('Preorder variant updated:', {
          selectedSku: newVariantSku,
          matchedVariant: matchingVariant.sku,
          matchedId: matchingVariant.id
        });
      } else {
        // No matching variant found
        this.#updateButtonState(null);
        console.warn('No matching preorder variant found for SKU:', newVariantSku);
      }
    } catch (error) {
      console.error('Error updating preorder variant:', error);
      this.#updateButtonState(null);
    }
  }

  /**
   * Find matching preorder variant based on SKU
   * @param {string} selectedSku - The SKU of the selected main product variant
   * @returns {Promise<Object|null>} - The matching preorder variant or null
   */
  async #findMatchingPreorderVariant(selectedSku) {
    if (!this.#preorderProduct) {
      this.#preorderProduct = await this.#fetchPreorderProduct();
    }

    if (!this.#preorderProduct) {
      return null;
    }

    const { variants } = this.#preorderProduct;

    // Strategy 1: Exact SKU match
    let matchingVariant = variants.find(v => v.sku === selectedSku);

    if (!matchingVariant) {
      // Strategy 2: Pattern-based matching
      const baseSku = selectedSku.replace(/-REGULAR|-REG|-STOCK/g, '');
      matchingVariant = variants.find(v => {
        const preorderBaseSku = v.sku.replace(/-PREORDER|-PRE|-BACKORDER/g, '');
        return baseSku === preorderBaseSku;
      });
    }

    if (!matchingVariant) {
      // Strategy 3: Match by variant position (if same number of variants)
      const mainProductVariants = await this.#getMainProductVariants();
      if (mainProductVariants && variants.length === mainProductVariants.length) {
        const selectedVariantIndex = mainProductVariants.findIndex(v => v.sku === selectedSku);
        if (selectedVariantIndex >= 0 && variants[selectedVariantIndex]) {
          matchingVariant = variants[selectedVariantIndex];
        }
      }
    }

    if (!matchingVariant) {
      // Fallback: Use first available variant
      matchingVariant = variants.find(v => v.available) || variants[0];
    }

    return matchingVariant;
  }

  /**
   * Fetch the preorder product data
   * @returns {Promise<Object|null>}
   */
  async #fetchPreorderProduct() {
    const preorderHandle = this.dataset.preorderHandle;
    if (!preorderHandle) {
      console.error('Preorder handle not found');
      return null;
    }

    try {
      const response = await fetch(`${window.location.origin}/products/${preorderHandle}.js`);
      if (!response.ok) {
        throw new Error(`Failed to fetch preorder product: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      console.error('Error fetching preorder product:', error);
      return null;
    }
  }

  /**
   * Get main product variants
   * @returns {Promise<Array|null>}
   */
  async #getMainProductVariants() {
    try {
      const currentPath = window.location.pathname;
      const productHandle = currentPath.split('/').pop();
      
      const response = await fetch(`${window.location.origin}/products/${productHandle}.js`);
      if (!response.ok) {
        throw new Error(`Failed to fetch main product: ${response.status}`);
      }
      const product = await response.json();
      return product.variants;
    } catch (error) {
      console.error('Error fetching main product variants:', error);
      return null;
    }
  }

  /**
   * Update button display with new variant info
   * @param {Object|null} variant - The matched preorder variant
   */
  #updateButtonDisplay(variant) {
    const button = this.querySelector('[data-preorder-button]');
    const priceElement = button?.querySelector('.preorder-text__content');
    
    if (!button || !priceElement) return;

    if (variant) {
      // Enable button and update price
      button.disabled = !variant.available;
      
      if (variant.available) {
        const formattedPrice = new Intl.NumberFormat(document.documentElement.lang || 'en', {
          style: 'currency',
          currency: Theme.currency?.active || 'USD'
        }).format(variant.price / 100);
        
        priceElement.textContent = `Pre-order - ${formattedPrice}`;
      } else {
        priceElement.textContent = 'Pre-order - Unavailable';
      }
    } else {
      // Disable button if no variant found
      button.disabled = true;
      priceElement.textContent = 'Pre-order - Not Available';
    }
  }

  /**
   * Update button state based on variant availability
   * @param {Object|null} variant 
   */
  #updateButtonState(variant) {
    const button = this.querySelector('[data-preorder-button]');
    if (!button) return;

    button.disabled = !variant || !variant.available;
  }

  /**
   * Handles the click event for the pre-order button.
   * @param {MouseEvent} event - The click event.
   */
  async #handleClick(event) {
    event.preventDefault();
    
    const button = event.target.closest('[data-preorder-button]');
    if (!button || button.disabled) return;

    const variantId = this.dataset.variantId;
    const preorderProductId = this.dataset.preorderProductId;
    const originalProductId = this.dataset.originalProductId;
    const currentVariantSku = this.dataset.currentVariantSku;

    if (!variantId) {
      console.error('Pre-order variant ID is required');
      return;
    }

    // Disable button and show loading state
    button.disabled = true;
    this.#animatePreorder();

    // Get quantity from the main product form or default to 1
    const quantity = this.#getSelectedQuantity();

    try {
      // Prepare form data
      const formData = new FormData();
      formData.append('id', variantId);
      formData.append('quantity', quantity.toString());
      
      // Add comprehensive properties to identify this as a pre-order
      formData.append('properties[_preorder]', 'true');
      formData.append('properties[_order_type]', 'pre-order');
      formData.append('properties[_original_product_id]', originalProductId);
      formData.append('properties[_preorder_product_id]', preorderProductId);
      formData.append('properties[_matched_sku]', currentVariantSku);
      formData.append('properties[_preorder_for]', this.#getMainProductHandle());

      // Add cart items sections for update
      this.#addCartSections(formData);

      const fetchCfg = fetchConfig('javascript', { body: formData });

      const response = await fetch(Theme.routes.cart_add_url, {
        ...fetchCfg,
        headers: {
          ...fetchCfg.headers,
          Accept: 'application/json',
        }
      });

      const result = await response.json();

      if (result.status) {
        // Handle error
        console.error('Pre-order add to cart error:', result.message);
        
        // Dispatch error event
        window.dispatchEvent(new CartErrorEvent(this.id, result.message));
        
        // Show error feedback
        this.#showError(result.message);
      } else {
        // Success - dispatch cart add event with proper item count calculation
        const actualItemCount = quantity; // Use the actual quantity added
        
        // Dispatch the cart add event to update cart icon and drawer
        const cartAddEvent = new CartAddEvent({}, variantId, {
          source: 'preorder-button-component',
          itemCount: actualItemCount,
          productId: preorderProductId,
          originalProductId: originalProductId,
          sections: result.sections,
          isPreorder: true
        });
        
        // Dispatch at both component and window level for better compatibility
        this.dispatchEvent(cartAddEvent);
        window.dispatchEvent(cartAddEvent);
        document.dispatchEvent(cartAddEvent);

        // Also trigger cart update event for cart drawer and icon
        const cartUpdateEvent = new CartUpdateEvent({}, this.id, {
          itemCount: actualItemCount,
          source: 'preorder-button-component',
          sections: result.sections
        });
        
        document.dispatchEvent(cartUpdateEvent);
        window.dispatchEvent(cartUpdateEvent);

        // Trigger fly-to-cart animation
        this.#animateFlyToCart(button);

        console.log(`Successfully added pre-order item to cart (quantity: ${actualItemCount})`);
      }

    } catch (error) {
      console.error('Pre-order request failed:', error);
      this.#showError('Something went wrong. Please try again.');
    } finally {
      // Re-enable button after animation
      setTimeout(() => {
        button.disabled = false;
        this.classList.remove('preorder-added');
      }, PREORDER_ANIMATION_DURATION + 500);

      // Track performance
      cartPerformance.measureFromEvent('preorder-add:user-action', event);
    }
  }

  /**
   * Get selected quantity from the main product form
   * @returns {number}
   */
  #getSelectedQuantity() {
    // Look for quantity input in the closest product form
    const productForm = this.closest('.product-information, .product-card');
    const quantityInput = productForm?.querySelector('input[name="quantity"]') || 
                          document.querySelector('input[name="quantity"]');
    
    const quantity = quantityInput ? parseInt(quantityInput.value, 10) : 1;
    return isNaN(quantity) || quantity < 1 ? 1 : quantity;
  }

  /**
   * Add cart sections to form data for proper cart update
   * @param {FormData} formData 
   */
  #addCartSections(formData) {
    const cartItemsComponents = document.querySelectorAll('cart-items-component');
    const sectionIds = [];
    
    cartItemsComponents.forEach((item) => {
      if (item instanceof HTMLElement && item.dataset.sectionId) {
        sectionIds.push(item.dataset.sectionId);
      }
    });
    
    if (sectionIds.length > 0) {
      formData.append('sections', sectionIds.join(','));
    }
  }

  /**
   * Get the main product handle from the current URL
   * @returns {string}
   */
  #getMainProductHandle() {
    return window.location.pathname.split('/').pop();
  }

  /**
   * Animates the pre-order button state change.
   */
  #animatePreorder() {
    if (this.#animationTimeout) clearTimeout(this.#animationTimeout);
    if (this.#cleanupTimeout) clearTimeout(this.#cleanupTimeout);

    if (!this.classList.contains('preorder-added')) {
      this.classList.add('preorder-added');
    }

    this.#animationTimeout = setTimeout(() => {
      this.#cleanupTimeout = setTimeout(() => {
        this.classList.remove('preorder-added');
      }, 10);
    }, PREORDER_ANIMATION_DURATION);
  }

  /**
   * Shows error message to user.
   * @param {string} message - Error message to display.
   */
  #showError(message) {
    const button = this.querySelector('[data-preorder-button]');
    const textElement = button?.querySelector('.preorder-text__content');
    
    if (!textElement) return;

    const originalText = textElement.textContent;
    textElement.textContent = 'Error - try again';
    
    setTimeout(() => {
      if (textElement) {
        textElement.textContent = originalText;
      }
    }, 3000);
  }

  /**
   * Animates the fly to cart effect.
   * @param {HTMLElement} sourceButton - The button that was clicked.
   */
  #animateFlyToCart(sourceButton) {
    const cartIcon = document.querySelector('.header-actions__cart-icon');
    
    if (!cartIcon || !sourceButton) return;

    // Get preorder product image for the flying animation
    const preorderProductImage = this.querySelector('[data-preorder-product-image]')?.src;
    
    if (!preorderProductImage) return;

    // Create and trigger fly-to-cart element
    const flyToCartElement = document.createElement('fly-to-cart');
    flyToCartElement.style.setProperty('background-image', `url(${preorderProductImage})`);
    flyToCartElement.source = sourceButton;
    flyToCartElement.destination = cartIcon;

    document.body.appendChild(flyToCartElement);
  }
}

// Register the custom element
if (!customElements.get('preorder-button-component')) {
  customElements.define('preorder-button-component', PreorderButtonComponent);
}
