import {
    $mobx,
    Atom,
    ComputedValue,
    IAtom,
    IComputedValueOptions,
    IEnhancer,
    IInterceptable,
    IListenable,
    Lambda,
    ObservableValue,
    addHiddenProp,
    assertPropertyConfigurable,
    createInstanceofPredicate,
    deepEnhancer,
    endBatch,
    getNextId,
    hasInterceptors,
    hasListeners,
    initializeInstance,
    interceptChange,
    invariant,
    isObject,
    isPlainObject,
    isPropertyConfigurable,
    isSpyEnabled,
    notifyListeners,
    referenceEnhancer,
    registerInterceptor,
    registerListener,
    spyReportEnd,
    spyReportStart,
    startBatch,
    stringifyKey,
    globalState
} from "../internal"

export interface IObservableObject {
    "observable-object": IObservableObject
}

export type IObjectDidChange =
    | {
          name: PropertyKey
          object: any
          type: "add"
          newValue: any
      }
    | {
          name: PropertyKey
          object: any
          type: "update"
          oldValue: any
          newValue: any
      }
    | {
          name: PropertyKey
          object: any
          type: "remove"
          oldValue: any
      }

export type IObjectWillChange =
    | {
          object: any
          type: "update" | "add"
          name: PropertyKey
          newValue: any
      }
    | {
          object: any
          type: "remove"
          name: PropertyKey
      }

export class ObservableObjectAdministration
    implements IInterceptable<IObjectWillChange>, IListenable {
    keysAtom: IAtom
    // 观察者
    changeListeners
    interceptors
    private proxy: any
    private pendingKeys: undefined | Map<PropertyKey, ObservableValue<boolean>>

    constructor(
        public target: any,
        public values = new Map<PropertyKey, ObservableValue<any> | ComputedValue<any>>(),
        public name: string,
        public defaultEnhancer: IEnhancer<any>
    ) {
        this.keysAtom = new Atom(name + ".keys")
    }

    read(key: PropertyKey) {
        // this.values.get(key) 获取 propName 对应 ComputedValue (或 ObservableValue) 实例, 并执行 get 方法
        return this.values.get(key)!.get()
    }

    write(key: PropertyKey, newValue) {
        const instance = this.target
        const observable = this.values.get(key)
        // @computed ComputedValue 实例
        if (observable instanceof ComputedValue) {
            observable.set(newValue)
            return
        }

        // intercept
        // observerable 对象中使用，用于修改 change 对象
        if (hasInterceptors(this)) {
            // 传入初始 change 对象，顺序执行 interceptors，链式调用
            const change = interceptChange<IObjectWillChange>(this, {
                type: "update",
                object: this.proxy || instance,
                name: key,
                newValue
            })
            // change 不存在时，直接返回
            if (!change) return
            newValue = (change as any).newValue
        }

        // @observable ObservableValue 实例 prepareNewValue 方法
        // prepareNewValue: 脏检测
        newValue = (observable as any).prepareNewValue(newValue)

        // notify spy & observers
        if (newValue !== globalState.UNCHANGED) {
            // 检测是否有 observers 需要通知
            const notify = hasListeners(this)
            const notifySpy = isSpyEnabled()
            const change =
                notify || notifySpy
                    ? {
                          type: "update",
                          object: this.proxy || instance,
                          oldValue: (observable as any).value,
                          name: key,
                          newValue
                      }
                    : null

            if (notifySpy && process.env.NODE_ENV !== "production")
                spyReportStart({ ...change, name: this.name, key })
            ;(observable as ObservableValue<any>).setNewValue(newValue)
            // 通知 listeners 执行回调，回调入参为 change 对象
            if (notify) notifyListeners(this, change)
            if (notifySpy && process.env.NODE_ENV !== "production") spyReportEnd()
        }
    }

    has(key: PropertyKey) {
        const map = this.pendingKeys || (this.pendingKeys = new Map())
        let entry = map.get(key)
        if (entry) return entry.get()
        else {
            const exists = !!this.values.get(key)
            // Possible optimization: Don't have a separate map for non existing keys,
            // but store them in the values map instead, using a special symbol to denote "not existing"
            entry = new ObservableValue(
                exists,
                referenceEnhancer,
                `${this.name}.${stringifyKey(key)}?`,
                false
            )
            map.set(key, entry)
            return entry.get() // read to subscribe
        }
    }

    addObservableProp(
        propName: PropertyKey,
        newValue,
        enhancer: IEnhancer<any> = this.defaultEnhancer
    ) {
        const { target } = this
        assertPropertyConfigurable(target, propName)

        if (hasInterceptors(this)) {
            const change = interceptChange<IObjectWillChange>(this, {
                object: this.proxy || target,
                name: propName,
                type: "add",
                newValue
            })
            if (!change) return
            newValue = (change as any).newValue
        }
        const observable = new ObservableValue(
            newValue,
            enhancer,
            `${this.name}.${stringifyKey(propName)}`,
            false
        )
        this.values.set(propName, observable)
        newValue = (observable as any).value // observableValue might have changed it

        Object.defineProperty(target, propName, generateObservablePropConfig(propName))
        this.notifyPropertyAddition(propName, newValue)
    }

    addComputedProp(
        propertyOwner: any, // where is the property declared?
        propName: PropertyKey,
        options: IComputedValueOptions<any>
    ) {
        const { target } = this
        options.name = options.name || `${this.name}.${stringifyKey(propName)}`
        // 创建 computedValue 实例, 挂载到 this.values[propName] 下
        // 每一个 computed prop 对应一个 computedValue 实例
        this.values.set(propName, new ComputedValue(options))
        if (propertyOwner === target || isPropertyConfigurable(propertyOwner, propName))
            // 真正设置 target[propName] 的 get set
            // get 对应 adm.read(propName); set 对应 adm.wirte(propName, v)
            // adm.read(propName) 实际会调用 对应 propName ComputedValue 实例的 get()
            // 也就是 [propName] 最初设置的 get set
            Object.defineProperty(propertyOwner, propName, generateComputedPropConfig(propName))
    }

    remove(key: PropertyKey) {
        if (!this.values.has(key)) return
        const { target } = this
        if (hasInterceptors(this)) {
            const change = interceptChange<IObjectWillChange>(this, {
                object: this.proxy || target,
                name: key,
                type: "remove"
            })
            if (!change) return
        }
        try {
            startBatch()
            const notify = hasListeners(this)
            const notifySpy = isSpyEnabled()
            const oldObservable = this.values.get(key)
            const oldValue = oldObservable && oldObservable.get()
            oldObservable && oldObservable.set(undefined)
            // notify key and keyset listeners
            this.keysAtom.reportChanged()
            this.values.delete(key)
            if (this.pendingKeys) {
                const entry = this.pendingKeys.get(key)
                if (entry) entry.set(false)
            }
            // delete the prop
            delete this.target[key]
            const change =
                notify || notifySpy
                    ? {
                          type: "remove",
                          object: this.proxy || target,
                          oldValue: oldValue,
                          name: key
                      }
                    : null
            if (notifySpy && process.env.NODE_ENV !== "production")
                spyReportStart({ ...change, name: this.name, key })
            if (notify) notifyListeners(this, change)
            if (notifySpy && process.env.NODE_ENV !== "production") spyReportEnd()
        } finally {
            endBatch()
        }
    }

    illegalAccess(owner, propName) {
        /**
         * This happens if a property is accessed through the prototype chain, but the property was
         * declared directly as own property on the prototype.
         *
         * E.g.:
         * class A {
         * }
         * extendObservable(A.prototype, { x: 1 })
         *
         * classB extens A {
         * }
         * console.log(new B().x)
         *
         * It is unclear whether the property should be considered 'static' or inherited.
         * Either use `console.log(A.x)`
         * or: decorate(A, { x: observable })
         *
         * When using decorate, the property will always be redeclared as own property on the actual instance
         */
        console.warn(
            `Property '${propName}' of '${owner}' was accessed through the prototype chain. Use 'decorate' instead to declare the prop or access it statically through it's owner`
        )
    }

    /**
     * Observes this object. Triggers for the events 'add', 'update' and 'delete'.
     * See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/observe
     * for callback details
     */
    // 注册 changeListeners，为当前可观察对象添加listeners
    // 观察 target
    observe(callback: (changes: IObjectDidChange) => void, fireImmediately?: boolean): Lambda {
        process.env.NODE_ENV !== "production" &&
            invariant(
                fireImmediately !== true,
                "`observe` doesn't support the fire immediately property for observable objects."
            )
        return registerListener(this, callback)
    }

    intercept(handler): Lambda {
        return registerInterceptor(this, handler)
    }

    notifyPropertyAddition(key: PropertyKey, newValue) {
        const notify = hasListeners(this)
        const notifySpy = isSpyEnabled()
        const change =
            notify || notifySpy
                ? {
                      type: "add",
                      object: this.proxy || this.target,
                      name: key,
                      newValue
                  }
                : null

        if (notifySpy && process.env.NODE_ENV !== "production")
            spyReportStart({ ...change, name: this.name, key })
        if (notify) notifyListeners(this, change)
        if (notifySpy && process.env.NODE_ENV !== "production") spyReportEnd()
        if (this.pendingKeys) {
            const entry = this.pendingKeys.get(key)
            if (entry) entry.set(true)
        }
        this.keysAtom.reportChanged()
    }

    getKeys(): PropertyKey[] {
        this.keysAtom.reportObserved()
        // return Reflect.ownKeys(this.values) as any
        const res: PropertyKey[] = []
        for (const [key, value] of this.values) if (value instanceof ObservableValue) res.push(key)
        return res
    }
}

export interface IIsObservableObject {
    $mobx: ObservableObjectAdministration
}

export function asObservableObject(
    target: any,
    name: PropertyKey = "",
    defaultEnhancer: IEnhancer<any> = deepEnhancer
): ObservableObjectAdministration {
    if (Object.prototype.hasOwnProperty.call(target, $mobx)) return target[$mobx]

    process.env.NODE_ENV !== "production" &&
        invariant(
            Object.isExtensible(target),
            "Cannot make the designated object observable; it is not extensible"
        )
    if (!isPlainObject(target))
        name = (target.constructor.name || "ObservableObject") + "@" + getNextId()
    if (!name) name = "ObservableObject@" + getNextId()

    const adm = new ObservableObjectAdministration(
        target,
        new Map(),
        stringifyKey(name),
        defaultEnhancer
    )
    // 实例化 adm , 并挂载到 target[$mobx] 上, 单例缓存
    addHiddenProp(target, $mobx, adm)
    return adm
}

const observablePropertyConfigs = Object.create(null)
const computedPropertyConfigs = Object.create(null)

export function generateObservablePropConfig(propName) {
    return (
        observablePropertyConfigs[propName] ||
        (observablePropertyConfigs[propName] = {
            configurable: true,
            enumerable: true,
            get() {
                return this[$mobx].read(propName)
            },
            set(v) {
                this[$mobx].write(propName, v)
            }
        })
    )
}

function getAdministrationForComputedPropOwner(owner: any): ObservableObjectAdministration {
    // 单例，一个 target 只有一个 adm实例
    const adm = owner[$mobx]
    if (!adm) {
        // because computed props are declared on proty,
        // the current instance might not have been initialized yet
        initializeInstance(owner)
        return owner[$mobx]
    }
    return adm
}

export function generateComputedPropConfig(propName) {
    return (
        computedPropertyConfigs[propName] ||
        (computedPropertyConfigs[propName] = {
            configurable: globalState.computedConfigurable,
            enumerable: false,
            get() {
                // amd.read
                return getAdministrationForComputedPropOwner(this).read(propName)
            },
            set(v) {
                // amd.write
                getAdministrationForComputedPropOwner(this).write(propName, v)
            }
        })
    )
}

const isObservableObjectAdministration = createInstanceofPredicate(
    "ObservableObjectAdministration",
    ObservableObjectAdministration
)

export function isObservableObject(thing: any): thing is IObservableObject {
    if (isObject(thing)) {
        // Initializers run lazily when transpiling to babel, so make sure they are run...
        initializeInstance(thing)
        return isObservableObjectAdministration((thing as any)[$mobx])
    }
    return false
}
