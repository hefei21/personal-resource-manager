import { computed, inject, useId, watchEffect } from 'vue'

// Each control owns its ID, including when a form item contains multiple fields.
// Explicit consumer names/descriptions take precedence over form-item defaults.
export function useNativeFormField(attrs, explicitId = () => attrs.id) {
  const item = inject('nativeFormItem', null)
  const generatedId = `native-field-${useId()}`
  const fieldId = computed(() => explicitId() || generatedId)
  watchEffect(onCleanup => {
    if (item) onCleanup(item.register(fieldId.value))
  })
  function fieldAttrs() {
    const describedBy = [attrs['aria-describedby'], item?.descriptionId.value].filter(Boolean).join(' ')
    return {
      id: fieldId.value,
      'aria-labelledby': attrs['aria-labelledby'] || (!attrs['aria-label'] ? item?.labelId.value : undefined),
      'aria-describedby': describedBy || undefined,
      'aria-invalid': attrs['aria-invalid'] ?? (item?.invalid.value ? 'true' : undefined),
      'aria-required': attrs['aria-required'] ?? (item?.required.value ? 'true' : undefined)
    }
  }
  return { fieldAttrs }
}
