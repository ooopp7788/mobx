import { EMPTY_ARRAY, addHiddenProp, fail } from "../internal"

export const mobxDidRunLazyInitializersSymbol = Symbol("mobx did run lazy initializers")
export const mobxPendingDecorators = Symbol("mobx pending decorators")

type DecoratorTarget = {
    [mobxDidRunLazyInitializersSymbol]?: boolean
    [mobxPendingDecorators]?: { [prop: string]: DecoratorInvocationDescription }
}

export type BabelDescriptor = PropertyDescriptor & { initializer?: () => any }

export type PropertyCreator = (
    instance: any,
    propertyName: PropertyKey,
    descriptor: BabelDescriptor | undefined,
    decoratorTarget: any,
    decoratorArgs: any[]
) => void

type DecoratorInvocationDescription = {
    prop: string
    propertyCreator: PropertyCreator
    descriptor: BabelDescriptor | undefined
    decoratorTarget: any
    decoratorArguments: any[]
}

const enumerableDescriptorCache: { [prop: string]: PropertyDescriptor } = {}
const nonEnumerableDescriptorCache: { [prop: string]: PropertyDescriptor } = {}

function createPropertyInitializerDescriptor(
    prop: string,
    enumerable: boolean
): PropertyDescriptor {
    const cache = enumerable ? enumerableDescriptorCache : nonEnumerableDescriptorCache
    return (
        cache[prop] ||
        (cache[prop] = {
            configurable: true,
            enumerable: enumerable,
            get() {
                // 包装get
                initializeInstance(this)
                return this[prop]
            },
            set(value) {
                // 包装set
                initializeInstance(this)
                this[prop] = value
            }
        })
    )
}

export function initializeInstance(target: any)
export function initializeInstance(target: DecoratorTarget) {
    if (target[mobxDidRunLazyInitializersSymbol] === true) return
    // 获取 target 上的 decorators, decorators 对象以 propNname 为 key, 储存相应 prop 的 decorators
    const decorators = target[mobxPendingDecorators]
    if (decorators) {
        // set target[mobxDidRunLazyInitializersSymbol]: true
        addHiddenProp(target, mobxDidRunLazyInitializersSymbol, true)
        // 遍历调用 target.decorators 上的所有 prop 对应 decorator.propertyCreator 方法
        // propertyCreator 方法就是 createPropDecorator 方法 第二个参数
        for (let key in decorators) {
            const d = decorators[key]
            d.propertyCreator(target, d.prop, d.descriptor, d.decoratorTarget, d.decoratorArguments)
        }
    }
}

export function createPropDecorator(
    propertyInitiallyEnumerable: boolean,
    propertyCreator: PropertyCreator
) {
    // arguments: target, name, descriptor
    return function decoratorFactory() {
        let decoratorArguments: any[]

        // run with arguments
        const decorator = function decorate(
            target: DecoratorTarget,
            prop: string,
            descriptor: BabelDescriptor | undefined,
            applyImmediately?: any
            // This is a special parameter to signal the direct application of a decorator, allow extendObservable to skip the entire type decoration part,
            // as the instance to apply the decorator to equals the target
        ) {
            if (applyImmediately === true) {
                propertyCreator(target, prop, descriptor, target, decoratorArguments)
                return null
            }
            if (process.env.NODE_ENV !== "production" && !quacksLikeADecorator(arguments))
                fail("This function is a decorator, but it wasn't invoked like a decorator")
            if (!Object.prototype.hasOwnProperty.call(target, mobxPendingDecorators)) {
                const inheritedDecorators = target[mobxPendingDecorators]
                addHiddenProp(target, mobxPendingDecorators, { ...inheritedDecorators })
            }
            // target[mobxPendingDecorators] 存放 decorators
            // decorators: 以 propName 为 key, 存放 decorator
            target[mobxPendingDecorators]![prop] = {
                prop,
                propertyCreator,
                descriptor,
                decoratorTarget: target,
                decoratorArguments
            }
            // 返回包裹后的 descriptor
            // 装饰器语法执行完毕
            return createPropertyInitializerDescriptor(prop, propertyInitiallyEnumerable)
        }

        if (quacksLikeADecorator(arguments)) {
            // @decorator
            decoratorArguments = EMPTY_ARRAY
            // run decorator
            return decorator.apply(null, arguments as any)
        } else {
            // @decorator(args)
            decoratorArguments = Array.prototype.slice.call(arguments)
            return decorator
        }
    } as Function
}

export function quacksLikeADecorator(args: IArguments): boolean {
    return (
        ((args.length === 2 || args.length === 3) && typeof args[1] === "string") ||
        (args.length === 4 && args[3] === true)
    )
}
