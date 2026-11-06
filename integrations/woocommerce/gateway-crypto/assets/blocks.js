// Registers the payment method in the Checkout block. No build step: WordPress globals only.
(function () {
  var settings = window.wc.wcSettings.getSetting('gateway_crypto_data', {});
  var el = window.wp.element.createElement;
  var decode = window.wp.htmlEntities.decodeEntities;
  var label = decode(settings.title || 'Pay with USDT');
  var Content = function () {
    return el('div', null, decode(settings.description || ''));
  };
  window.wc.wcBlocksRegistry.registerPaymentMethod({
    name: 'gateway_crypto',
    label: label,
    ariaLabel: label,
    content: el(Content),
    edit: el(Content),
    canMakePayment: function () {
      return true;
    },
    supports: { features: settings.supports || ['products'] },
  });
})();
