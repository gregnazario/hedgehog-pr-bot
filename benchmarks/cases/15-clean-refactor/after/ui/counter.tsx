export function Counter({ start = 0 }: { start?: number }) {
  const [count, setCount] = useState(start);

  const update = (delta: number) => setCount((value) => value + delta);

  return (
    <div>
      <button onClick={() => update(1)}>+</button>
      <span>{count}</span>
      <button onClick={() => update(-1)}>-</button>
    </div>
  );
}
