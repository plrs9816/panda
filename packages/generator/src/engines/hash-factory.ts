import {
  filterBaseConditions,
  getOrCreateSet,
  getSlotRecipes,
  isObjectOrArray,
  normalizeStyleObject,
  toResponsiveObject,
  traverse,
} from '@pandacss/shared'
import type {
  Dict,
  RecipeConfig,
  RecipeVariantRecord,
  ResultItem,
  SlotRecipeConfig,
  SlotRecipeVariantRecord,
  StyleEntry,
  StyleProps,
  StyleResultObject,
} from '@pandacss/types'
import type { GeneratorBaseEngine } from './base'

export interface CollectorContext
  extends Pick<
    GeneratorBaseEngine,
    | 'hash'
    | 'isTemplateLiteralSyntax'
    | 'isValidProperty'
    | 'conditions'
    | 'recipes'
    | 'utility'
    | 'patterns'
    | 'createSheet'
  > {}

const identity = (v: any) => v

export class HashFactory {
  static separator = ']___['
  static conditionSeparator = '<___>'

  atomic = new Set<string>()
  compound_variants = new Set<string>()
  //
  recipes = new Map<string, Set<string>>()
  recipes_base = new Map<string, Set<string>>()
  //
  recipes_slots = new Map<string, Set<string>>()
  recipes_slots_base = new Map<string, Set<string>>()

  private filterStyleProps: (props: Dict) => Dict

  constructor(private context: CollectorContext) {
    this.filterStyleProps = context.isTemplateLiteralSyntax
      ? identity
      : (props: Dict) => filterProps(this.context.isValidProperty, props)
  }

  fork() {
    return new HashFactory(this.context)
  }

  isEmpty() {
    return (
      !this.atomic.size &&
      !this.recipes.size &&
      !this.recipes_slots.size &&
      !this.compound_variants.size &&
      !this.recipes_base.size &&
      !this.recipes_slots_base.size
    )
  }

  get hashes() {
    return {
      atomic: this.atomic,
      recipes: this.recipes,
      recipes_base: this.recipes_base,
      recipes_slots: this.recipes_slots,
      recipes_slots_base: this.recipes_slots_base,
    }
  }
  /**
   * Hashes a style object and adds the resulting hashes to a set.
   * @param set - The set to add the resulting hashes to.
   * @param obj - The style object to hash.
   * @param baseEntry - An optional base style entry to use when hashing the style object.
   */
  hashStyleObject(
    set: Set<string>,
    obj: ResultItem['data'][number],
    baseEntry?: Partial<Omit<StyleEntry, 'prop' | 'value' | 'cond'>>,
  ) {
    const isCondition = this.context.conditions.isCondition
    const traverseOptions = { separator: HashFactory.conditionSeparator }

    // _dark: { color: 'white' }
    //          ^^^^^^^^^^^^^^
    let isInCondition = false

    // Is the final (leading to a raw value, not an object) property a condition ?
    // mx: { base: { p: 4, _hover: 5 } }
    //                            ^^^
    let isFinalCondition = false
    let cond = ''
    let prop = ''
    let prevProp = ''
    let prevDepth = 0

    // { mx: 4 } => { marginX: 4 }
    const normalized = normalizeStyleObject(obj, this.context)

    traverse(
      normalized,
      ({ key, value: rawValue, path, depth }) => {
        if (rawValue === undefined) {
          return
        }

        // { mx: [1, 2, 3] } => { mx: { base: 1, sm: 2, md: 3 } }
        const value = Array.isArray(rawValue)
          ? toResponsiveObject(rawValue, this.context.conditions.breakpoints.keys)
          : rawValue

        isFinalCondition = false
        prop = key

        // { _hover: { ... } }
        //   ^^^^^^
        if (isCondition(key)) {
          // { _hover: { ... } }
          //           ^^^^^^^
          if (isObjectOrArray(value)) {
            isInCondition = true
            cond = path
            prevDepth = depth
            return
          }

          // { _hover: { base: 4 } }
          //             ^^^^^^^
          cond = isInCondition && cond ? path.replace(HashFactory.conditionSeparator + prevProp, '') : key
          prop = prevProp
          isFinalCondition = true
        } else if (isObjectOrArray(value)) {
          // { mx: { base: 4 } }
          //       ^^^^^^^^^^^
          prevProp = prop
          prevDepth = depth
          return
        }

        // when we were in a condition and now back to a root prop
        // we need to reset the condition state
        if (!isFinalCondition && isInCondition && path === prop) {
          isInCondition = false
          cond = ''
        }
        // when the depth changes and that we were not in a condition
        // we need to check if we are back to a condition now
        else if (depth !== prevDepth && !isInCondition && !isFinalCondition) {
          cond = getPreviousCondition(path)
          isInCondition = cond !== ''
        }

        const resolvedCondition = getResolvedCondition(cond, isCondition)

        const hashed = hashStyleEntry(Object.assign(baseEntry ?? {}, { prop, value, cond: resolvedCondition }))
        set.add(hashed)

        prevProp = prop
        prevDepth = depth
      },
      traverseOptions,
    )
  }

  processAtomic(styles: StyleResultObject) {
    this.hashStyleObject(this.atomic, styles)
  }

  processStyleProps(styleProps: StyleProps) {
    const styles = this.filterStyleProps(styleProps)

    if (styles.css) {
      this.processAtomic(styles.css)
    }

    this.processAtomic(styles.css ? Object.assign({}, styles, { css: undefined }) : styles)
  }

  processRecipe(recipeName: string, variants: RecipeVariantRecord) {
    const config = this.context.recipes.getConfig(recipeName)
    if (!config) return

    const set = getOrCreateSet(this.recipes, recipeName)
    const styles = Object.assign({}, config.defaultVariants, variants)
    this.hashStyleObject(set, styles, { recipe: recipeName })

    if (config.base && !this.recipes_base.has(recipeName)) {
      const base_set = getOrCreateSet(this.recipes_base, recipeName)
      this.hashStyleObject(base_set, config.base, { recipe: recipeName })
    }

    if (config.compoundVariants && !this.compound_variants.has(recipeName)) {
      this.compound_variants.add(recipeName)
      config.compoundVariants.forEach((compoundVariant) => {
        this.processAtomic(compoundVariant.css)
      })
    }
  }

  processSlotRecipe(recipeName: string, variants: SlotRecipeVariantRecord<string>) {
    const config = this.context.recipes.getConfig(recipeName) as SlotRecipeConfig | undefined
    if (!config) return

    const styles = Object.assign({}, config.defaultVariants, variants)
    config.slots.forEach((slot) => {
      const recipeKey = this.context.recipes.getSlotKey(recipeName, slot)

      const set = getOrCreateSet(this.recipes_slots, recipeKey)
      this.hashStyleObject(set, styles, { recipe: recipeName, slot })

      const slotBase = config.base?.[slot]
      if (slotBase && !this.recipes_slots_base.has(recipeKey)) {
        const base_set = getOrCreateSet(this.recipes_slots_base, recipeKey)
        this.hashStyleObject(base_set, slotBase, { recipe: recipeName, slot })
      }
    })

    if (config.compoundVariants && !this.compound_variants.has(recipeName)) {
      this.compound_variants.add(recipeName)
      config.compoundVariants.forEach((compoundVariant) => {
        Object.values(compoundVariant.css).forEach((styles) => this.processAtomic(styles ?? {}))
      })
    }
  }

  processPattern(
    name: string,
    patternProps: StyleResultObject,
    type?: 'pattern' | 'jsx-pattern',
    jsxName?: string | undefined,
  ) {
    let fnName = name
    if (type === 'jsx-pattern' && jsxName) {
      fnName = this.context.patterns.getFnName(jsxName)
    }
    const styleProps = this.context.patterns.transform(fnName, patternProps)
    this.processStyleProps(styleProps)
  }

  processAtomicRecipe(recipe: Pick<RecipeConfig, 'base' | 'variants' | 'compoundVariants'>) {
    const { base = {}, variants = {}, compoundVariants = [] } = recipe
    this.processAtomic(base)
    for (const variant of Object.values(variants)) {
      for (const styles of Object.values(variant)) {
        this.processAtomic(styles)
      }
    }

    compoundVariants.forEach((compoundVariant) => {
      this.processAtomic(compoundVariant.css)
    })
  }

  processAtomicSlotRecipe(recipe: Pick<SlotRecipeConfig, 'base' | 'variants' | 'compoundVariants'>) {
    const slots = getSlotRecipes(recipe)
    for (const slotRecipe of Object.values(slots)) {
      this.processAtomicRecipe(slotRecipe)
    }
  }
}

const filterProps = (isValidProperty: (key: string) => boolean, props: Dict) => {
  const clone = {} as Dict
  for (const [key, value] of Object.entries(props)) {
    if (isValidProperty(key) && value !== undefined) {
      clone[key] = value
    }
  }
  return clone
}

const hashStyleEntry = (entry: StyleEntry) => {
  const parts = [`${entry.prop}${HashFactory.separator}value:${entry.value}`]

  if (entry.cond) {
    parts.push(`cond:${entry.cond}`)
  }

  if (entry.recipe) {
    parts.push(`recipe:${entry.recipe}`)
  }

  if (entry.layer) {
    parts.push(`layer:${entry.layer}`)
  }

  if (entry.slot) {
    parts.push(`slot:${entry.slot}`)
  }

  return parts.join(HashFactory.separator)
}

const getPreviousCondition = (path: string): string => path.split(HashFactory.conditionSeparator).at(-2) ?? ''

/**
 * Returns the final condition string after filtering out irrelevant parts. ('base' and props)
 * @example
 * 'marginTop<___>md' => 'md'
 * 'marginTop<___>md<___>lg' => 'md<___>lg'
 * '_hover' => '_hover'
 * '& > p<___>base', => '& > p'
 * '@media base' => '@media base'
 * '_hover<___>base<___>_dark' => '_hover<___>_dark'
 *
 */
const getResolvedCondition = (cond: string, isCondition: (key: string) => boolean): string => {
  if (!cond) {
    return ''
  }

  const parts = cond.split(HashFactory.conditionSeparator)
  const first = parts[0]
  let relevantParts = filterBaseConditions(parts)

  if (first && !isCondition(first)) {
    relevantParts = relevantParts.slice(1)
  }

  if (parts.length !== relevantParts.length) {
    return relevantParts.join(HashFactory.conditionSeparator)
  }

  return cond
}
